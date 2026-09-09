// Command worker drains the generation queue.
//
// Steps, in order:
//  1. mark the job running
//  2. read the Anthropic key from Secrets Manager, cached across invocations
//  3. call the Messages API with structured output -- the model returns the
//     fields of model.SiteContent, never markup (README section 5.1)
//  4. render with internal/render, which escapes by context
//  5. PUT to s3://$SITES_BUCKET/sites/{slug}/index.html
//  6. mark the job done with the public URL
//
// Use prompt caching: the system prompt is byte-identical for every
// participant, so it caches after the first call and reads back at roughly a
// tenth of the input price.
//
// Concurrency is capped by the function's reserved concurrency, not here --
// that is what keeps a burst from becoming a wall of 429s.
package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

type config struct {
	JobsTable         string
	ParticipantsTable string
	SitesBucket       string
	AnthropicSecret   string
	AnthropicModel    string
	Domain            string
}

var cfg = config{
	JobsTable:         os.Getenv("JOBS_TABLE"),
	ParticipantsTable: os.Getenv("PARTICIPANTS_TABLE"),
	SitesBucket:       os.Getenv("SITES_BUCKET"),
	AnthropicSecret:   os.Getenv("ANTHROPIC_SECRET"),
	AnthropicModel:    os.Getenv("ANTHROPIC_MODEL"),
	Domain:            os.Getenv("DOMAIN"),
}

// handler returns per-message failures so SQS redrives only what actually
// failed, rather than the whole batch.
func handler(ctx context.Context, event events.SQSEvent) (events.SQSEventResponse, error) {
	var resp events.SQSEventResponse

	for _, msg := range event.Records {
		slog.Info("job received", "messageID", msg.MessageId, "model", cfg.AnthropicModel)
		// Pending: steps 1-6 above.
	}

	return resp, nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	lambda.Start(handler)
}
