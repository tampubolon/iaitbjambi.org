// Command api serves the participant-facing HTTP API behind API Gateway.
//
// Routes (README section 7):
//
//	POST /redeem          {code}   -> {token, slug}
//	POST /generate        {fields} -> {job_id}
//	GET  /status/{job_id}          -> {status, url?}
//	GET  /me                       -> {slug, remaining}
//
// Generation is enqueued rather than performed here: API Gateway caps an
// integration response at 29 seconds and a generation can exceed that.
//
// Invariants this command must enforce (README section 8):
//   - reject once participants.generation_count reaches MAX_GENERATIONS
//   - a slug is assigned once and never changes
//   - a code may be redeemed once
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

type config struct {
	JobsTable         string
	ParticipantsTable string
	QueueURL          string
	Domain            string
	MaxGenerations    string
}

var cfg = config{
	JobsTable:         os.Getenv("JOBS_TABLE"),
	ParticipantsTable: os.Getenv("PARTICIPANTS_TABLE"),
	QueueURL:          os.Getenv("QUEUE_URL"),
	Domain:            os.Getenv("DOMAIN"),
	MaxGenerations:    os.Getenv("MAX_GENERATIONS"),
}

func respond(status int, body any) (events.APIGatewayV2HTTPResponse, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return events.APIGatewayV2HTTPResponse{StatusCode: http.StatusInternalServerError}, nil
	}
	return events.APIGatewayV2HTTPResponse{
		StatusCode: status,
		Headers:    map[string]string{"content-type": "application/json; charset=utf-8"},
		Body:       string(b),
	}, nil
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	route := req.RouteKey
	slog.Info("request", "route", route, "requestID", req.RequestContext.RequestID)

	switch route {
	case "POST /redeem", "POST /generate", "GET /status/{job_id}", "GET /me":
		// Infrastructure is deployed; handler logic is pending.
		return respond(http.StatusNotImplemented, map[string]string{
			"error":   "not_implemented",
			"route":   route,
			"message": "Infrastruktur sudah aktif, logika belum diimplementasikan.",
		})
	default:
		return respond(http.StatusNotFound, map[string]string{"error": "not_found"})
	}
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	lambda.Start(handler)
}
