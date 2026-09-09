// Command api serves the participant-facing HTTP API behind API Gateway.
//
//	POST /redeem          {code}   -> {token, slug, remaining}
//	POST /generate        {prompt} -> {job_id}
//	GET  /status/{job_id}          -> {status, url?, message?}
//	GET  /me                       -> {slug, remaining}
//
// Generation is enqueued, never performed here: API Gateway caps an
// integration response at 29 seconds and a generation can exceed it.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	awscfg "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/google/uuid"

	"github.com/tampubolon/iaitbjambi.org/aiimpact-demo/internal/auth"
	"github.com/tampubolon/iaitbjambi.org/aiimpact-demo/internal/model"
	"github.com/tampubolon/iaitbjambi.org/aiimpact-demo/internal/store"
)

const (
	minPromptLen = 25
	maxPromptLen = 4000
)

type app struct {
	st       *store.Store
	signer   *auth.Signer
	sqs      *sqs.Client
	queueURL string
	domain   string
	maxGen   int
}

var a *app

func setup(ctx context.Context) (*app, error) {
	maxGen, err := strconv.Atoi(os.Getenv("MAX_GENERATIONS"))
	if err != nil || maxGen <= 0 {
		return nil, fmt.Errorf("api: MAX_GENERATIONS invalid: %q", os.Getenv("MAX_GENERATIONS"))
	}
	signer, err := auth.NewSigner(os.Getenv("SESSION_SECRET"))
	if err != nil {
		return nil, err
	}
	st, err := store.New(ctx, os.Getenv("JOBS_TABLE"), os.Getenv("PARTICIPANTS_TABLE"))
	if err != nil {
		return nil, err
	}
	cfg, err := awscfg.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("api: aws config: %w", err)
	}
	return &app{
		st: st, signer: signer,
		sqs:      sqs.NewFromConfig(cfg),
		queueURL: os.Getenv("QUEUE_URL"),
		domain:   os.Getenv("DOMAIN"),
		maxGen:   maxGen,
	}, nil
}

// --- plumbing ---------------------------------------------------------------

type resp = events.APIGatewayV2HTTPResponse

func reply(status int, body any) (resp, error) {
	b, err := json.Marshal(body)
	if err != nil {
		slog.Error("marshal response", "err", err)
		return resp{StatusCode: http.StatusInternalServerError}, nil
	}
	return resp{
		StatusCode: status,
		Headers: map[string]string{
			"content-type":  "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
		Body: string(b),
	}, nil
}

// fault maps a status to the phrase the participant sees. The UI has its own
// copy for network failures; these cover what only the server knows.
func fault(status int, msg string) (resp, error) {
	return reply(status, map[string]string{"error": http.StatusText(status), "message": msg})
}

func (a *app) codeFromToken(req events.APIGatewayV2HTTPRequest) (string, bool) {
	tok := auth.Bearer(req.Headers["authorization"])
	if tok == "" {
		return "", false
	}
	code, err := a.signer.Verify(tok, time.Now())
	if err != nil {
		return "", false
	}
	return code, true
}

func (a *app) remaining(p *model.Participant) int {
	if r := a.maxGen - p.GenerationCount; r > 0 {
		return r
	}
	return 0
}

// --- handlers ---------------------------------------------------------------

func (a *app) redeem(ctx context.Context, req events.APIGatewayV2HTTPRequest) (resp, error) {
	var in struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal([]byte(req.Body), &in); err != nil || in.Code == "" {
		return fault(http.StatusBadRequest, "Kode tidak terbaca. Coba ketik ulang.")
	}

	p, err := a.st.Redeem(ctx, in.Code)
	if errors.Is(err, store.ErrNotFound) {
		return fault(http.StatusNotFound, "Kode tidak ditemukan. Periksa lembar peserta Anda.")
	}
	if err != nil {
		slog.Error("redeem", "err", err)
		return fault(http.StatusInternalServerError, "Server sedang sibuk. Coba lagi sebentar lagi.")
	}

	return reply(http.StatusOK, map[string]any{
		"token":     a.signer.Sign(p.Code, time.Now()),
		"slug":      p.Slug,
		"remaining": a.remaining(p),
	})
}

func (a *app) generate(ctx context.Context, req events.APIGatewayV2HTTPRequest) (resp, error) {
	code, ok := a.codeFromToken(req)
	if !ok {
		return fault(http.StatusUnauthorized, "Sesi Anda berakhir. Masukkan kode lagi.")
	}

	var in struct {
		Prompt string `json:"prompt"`
	}
	if err := json.Unmarshal([]byte(req.Body), &in); err != nil {
		return fault(http.StatusBadRequest, "Permintaan tidak terbaca.")
	}
	if len(in.Prompt) < minPromptLen {
		return fault(http.StatusBadRequest,
			"Ceritakan sedikit lebih lengkap — nama usaha, menu, dan nomor WhatsApp.")
	}
	if len(in.Prompt) > maxPromptLen {
		return fault(http.StatusBadRequest, "Cerita Anda terlalu panjang. Ringkas sedikit ya.")
	}

	// Atomic: the cap is what bounds worst-case spend, so it is enforced by a
	// conditional write rather than a read followed by a decision.
	count, err := a.st.CountGeneration(ctx, code, a.maxGen)
	switch {
	case errors.Is(err, store.ErrCapReached):
		return fault(http.StatusTooManyRequests,
			"Anda sudah mencapai batas pembuatan. Hubungi panitia bila perlu tambahan.")
	case errors.Is(err, store.ErrNotFound):
		return fault(http.StatusNotFound, "Kode tidak ditemukan.")
	case err != nil:
		slog.Error("count generation", "err", err)
		return fault(http.StatusInternalServerError, "Server sedang sibuk. Coba lagi sebentar lagi.")
	}

	job := model.Job{JobID: uuid.NewString(), Code: code}
	if err := a.st.CreateJob(ctx, job); err != nil {
		slog.Error("create job", "err", err)
		return fault(http.StatusInternalServerError, "Gagal memulai. Coba lagi.")
	}

	body, err := json.Marshal(map[string]string{"job_id": job.JobID, "code": code, "prompt": in.Prompt})
	if err != nil {
		slog.Error("marshal job message", "err", err)
		return fault(http.StatusInternalServerError, "Gagal memulai. Coba lagi.")
	}
	if _, err := a.sqs.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    aws.String(a.queueURL),
		MessageBody: aws.String(string(body)),
	}); err != nil {
		// The count is already spent. Marking the job failed is what tells the
		// participant something went wrong rather than leaving them polling.
		slog.Error("enqueue", "err", err, "job", job.JobID)
		_ = a.st.SetJobStatus(ctx, job.JobID, model.StatusError, "", "Gagal mengirim ke antrean.")
		return fault(http.StatusInternalServerError, "Gagal mengirim permintaan. Coba lagi.")
	}

	slog.Info("queued", "job", job.JobID, "generation", count)
	return reply(http.StatusAccepted, map[string]any{
		"job_id":    job.JobID,
		"remaining": a.maxGen - count,
	})
}

func (a *app) status(ctx context.Context, req events.APIGatewayV2HTTPRequest) (resp, error) {
	id := req.PathParameters["job_id"]
	if id == "" {
		return fault(http.StatusBadRequest, "Permintaan tidak lengkap.")
	}

	j, err := a.st.Job(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return fault(http.StatusNotFound, "Permintaan tidak ditemukan.")
	}
	if err != nil {
		slog.Error("get job", "err", err)
		return fault(http.StatusInternalServerError, "Server sedang sibuk.")
	}

	out := map[string]any{"status": j.Status}
	if j.URL != "" {
		out["url"] = j.URL
	}
	if j.Message != "" {
		out["message"] = j.Message
	}
	return reply(http.StatusOK, out)
}

func (a *app) me(ctx context.Context, req events.APIGatewayV2HTTPRequest) (resp, error) {
	code, ok := a.codeFromToken(req)
	if !ok {
		return fault(http.StatusUnauthorized, "Sesi Anda berakhir. Masukkan kode lagi.")
	}
	p, err := a.st.Participant(ctx, code)
	if errors.Is(err, store.ErrNotFound) {
		return fault(http.StatusNotFound, "Kode tidak ditemukan.")
	}
	if err != nil {
		slog.Error("get participant", "err", err)
		return fault(http.StatusInternalServerError, "Server sedang sibuk.")
	}

	out := map[string]any{"slug": p.Slug, "remaining": a.remaining(p)}
	if p.Slug != "" {
		out["url"] = fmt.Sprintf("https://%s.%s", p.Slug, a.domain)
	}
	return reply(http.StatusOK, out)
}

// --- entry point ------------------------------------------------------------

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (resp, error) {
	switch req.RouteKey {
	case "POST /redeem":
		return a.redeem(ctx, req)
	case "POST /generate":
		return a.generate(ctx, req)
	case "GET /status/{job_id}":
		return a.status(ctx, req)
	case "GET /me":
		return a.me(ctx, req)
	default:
		return fault(http.StatusNotFound, "Alamat tidak dikenal.")
	}
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	var err error
	if a, err = setup(context.Background()); err != nil {
		// Failing at cold start is correct: a misconfigured function should
		// not serve requests it cannot complete.
		slog.Error("startup", "err", err)
		os.Exit(1)
	}
	lambda.Start(handler)
}
