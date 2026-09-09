// Package store is the DynamoDB access layer.
//
// Two operations here carry correctness weight and are written as conditional
// writes rather than read-then-write: claiming a slug and incrementing a
// participant's generation count. Both are contended -- 200 people submitting
// inside the same 30 seconds -- and a check-then-act version of either would
// be wrong under exactly the load this system is built for.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/tampubolon/iaitbjambi.org/aiimpact-demo/internal/model"
)

// Sentinel errors callers branch on. The API turns these into the messages a
// participant actually sees, so they must be distinguishable.
var (
	ErrNotFound   = errors.New("store: not found")
	ErrCapReached = errors.New("store: generation cap reached")
	ErrSlugTaken  = errors.New("store: slug already claimed")
)

// Store holds the table handles. One per process; safe for concurrent use.
type Store struct {
	db           *dynamodb.Client
	jobs         string
	participants string
}

// New builds a Store from the ambient AWS config.
func New(ctx context.Context, jobsTable, participantsTable string) (*Store, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("store: load aws config: %w", err)
	}
	return &Store{
		db:           dynamodb.NewFromConfig(cfg),
		jobs:         jobsTable,
		participants: participantsTable,
	}, nil
}

func key(name, value string) map[string]ddbtypes.AttributeValue {
	return map[string]ddbtypes.AttributeValue{name: &ddbtypes.AttributeValueMemberS{Value: value}}
}

// --- participants ----------------------------------------------------------

// Participant reads one participant by code.
func (s *Store) Participant(ctx context.Context, code string) (*model.Participant, error) {
	out, err := s.db.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.participants),
		Key:       key("code", code),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get participant: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}

	var p model.Participant
	if err := attributevalue.UnmarshalMap(out.Item, &p); err != nil {
		return nil, fmt.Errorf("store: unmarshal participant: %w", err)
	}
	return &p, nil
}

// Redeem marks a code as first used and returns the participant.
//
// Deliberately idempotent: a participant who reloads the page, loses signal
// mid-request, or reopens the link must not be locked out of their own code
// with no recovery path short of finding a panitia member. Single-use is
// enforced socially -- one code per printed handout -- not by refusing the
// second request.
func (s *Store) Redeem(ctx context.Context, code string) (*model.Participant, error) {
	now, err := attributevalue.Marshal(time.Now().UTC())
	if err != nil {
		return nil, fmt.Errorf("store: marshal time: %w", err)
	}

	out, err := s.db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:           aws.String(s.participants),
		Key:                 key("code", code),
		UpdateExpression:    aws.String("SET redeemed_at = if_not_exists(redeemed_at, :now)"),
		ConditionExpression: aws.String("attribute_exists(code)"),
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":now": now,
		},
		ReturnValues: ddbtypes.ReturnValueAllNew,
	})
	if err != nil {
		var cond *ddbtypes.ConditionalCheckFailedException
		if errors.As(err, &cond) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("store: redeem: %w", err)
	}

	var p model.Participant
	if err := attributevalue.UnmarshalMap(out.Attributes, &p); err != nil {
		return nil, fmt.Errorf("store: unmarshal participant: %w", err)
	}
	return &p, nil
}

// SlugFree reports whether a label is unclaimed, via the slug GSI.
func (s *Store) SlugFree(ctx context.Context, slug string) (bool, error) {
	out, err := s.db.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(s.participants),
		IndexName:              aws.String("slug-index"),
		KeyConditionExpression: aws.String("slug = :s"),
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":s": &ddbtypes.AttributeValueMemberS{Value: slug},
		},
		Limit: aws.Int32(1),
	})
	if err != nil {
		return false, fmt.Errorf("store: query slug: %w", err)
	}
	return len(out.Items) == 0, nil
}

// ClaimSlug binds a slug to a participant, once.
//
// The condition makes this safe against two participants racing for the same
// name: the loser gets ErrSlugTaken and retries with the next suffix. It also
// makes the binding permanent -- a slug is in someone's WhatsApp history the
// moment it is published, so it must never move to a different business.
//
// Note the GSI is eventually consistent, so SlugFree can report a stale free.
// This condition is what actually enforces uniqueness; SlugFree only keeps the
// common case cheap.
func (s *Store) ClaimSlug(ctx context.Context, code, slug string) error {
	_, err := s.db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:           aws.String(s.participants),
		Key:                 key("code", code),
		UpdateExpression:    aws.String("SET slug = :slug"),
		ConditionExpression: aws.String("attribute_exists(code) AND attribute_not_exists(slug)"),
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":slug": &ddbtypes.AttributeValueMemberS{Value: slug},
		},
	})
	if err != nil {
		var cond *ddbtypes.ConditionalCheckFailedException
		if errors.As(err, &cond) {
			return ErrSlugTaken
		}
		return fmt.Errorf("store: claim slug: %w", err)
	}
	return nil
}

// CountGeneration increments a participant's generation count if, and only if,
// they are under the cap, and returns the new count.
//
// This is a single conditional ADD rather than read-check-write. Under the
// burst this system is designed for, a participant tapping twice would
// otherwise pass the check twice and exceed the cap -- and the cap is what
// bounds worst-case spend.
func (s *Store) CountGeneration(ctx context.Context, code string, max int) (int, error) {
	out, err := s.db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:        aws.String(s.participants),
		Key:              key("code", code),
		UpdateExpression: aws.String("SET generation_count = if_not_exists(generation_count, :zero) + :one"),
		ConditionExpression: aws.String(
			"attribute_exists(code) AND (attribute_not_exists(generation_count) OR generation_count < :max)"),
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":zero": &ddbtypes.AttributeValueMemberN{Value: "0"},
			":one":  &ddbtypes.AttributeValueMemberN{Value: "1"},
			":max":  &ddbtypes.AttributeValueMemberN{Value: fmt.Sprint(max)},
		},
		ReturnValues: ddbtypes.ReturnValueAllNew,
	})
	if err != nil {
		var cond *ddbtypes.ConditionalCheckFailedException
		if errors.As(err, &cond) {
			// Either the code does not exist or the cap is reached. Tell them
			// apart so the participant gets the right message.
			if _, gErr := s.Participant(ctx, code); errors.Is(gErr, ErrNotFound) {
				return 0, ErrNotFound
			}
			return 0, ErrCapReached
		}
		return 0, fmt.Errorf("store: count generation: %w", err)
	}

	var p model.Participant
	if err := attributevalue.UnmarshalMap(out.Attributes, &p); err != nil {
		return 0, fmt.Errorf("store: unmarshal participant: %w", err)
	}
	return p.GenerationCount, nil
}

// --- jobs ------------------------------------------------------------------

// JobTTL is how long a finished job row survives. Long enough for a
// participant to come back to it during the session, short enough that the
// table empties itself afterwards.
const JobTTL = 7 * 24 * time.Hour

// CreateJob writes a queued job.
func (s *Store) CreateJob(ctx context.Context, j model.Job) error {
	j.CreatedAt = time.Now().UTC()
	j.TTL = j.CreatedAt.Add(JobTTL).Unix()
	j.Status = model.StatusQueued

	item, err := attributevalue.MarshalMap(j)
	if err != nil {
		return fmt.Errorf("store: marshal job: %w", err)
	}
	if _, err := s.db.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.jobs),
		Item:      item,
	}); err != nil {
		return fmt.Errorf("store: put job: %w", err)
	}
	return nil
}

// Job reads one job.
func (s *Store) Job(ctx context.Context, id string) (*model.Job, error) {
	out, err := s.db.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.jobs),
		Key:       key("job_id", id),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get job: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}

	var j model.Job
	if err := attributevalue.UnmarshalMap(out.Item, &j); err != nil {
		return nil, fmt.Errorf("store: unmarshal job: %w", err)
	}
	return &j, nil
}

// SetJobStatus advances a job. url and message are optional.
func (s *Store) SetJobStatus(ctx context.Context, id string, st model.JobStatus, url, message string) error {
	values := map[string]ddbtypes.AttributeValue{
		":s": &ddbtypes.AttributeValueMemberS{Value: string(st)},
	}
	expr := "SET #st = :s"
	if url != "" {
		expr += ", #u = :u"
		values[":u"] = &ddbtypes.AttributeValueMemberS{Value: url}
	}
	if message != "" {
		expr += ", #m = :m"
		values[":m"] = &ddbtypes.AttributeValueMemberS{Value: message}
	}

	names := map[string]string{"#st": "status"} // status is a reserved word
	if url != "" {
		names["#u"] = "url"
	}
	if message != "" {
		names["#m"] = "message"
	}

	if _, err := s.db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.jobs),
		Key:                       key("job_id", id),
		UpdateExpression:          aws.String(expr),
		ExpressionAttributeNames:  names,
		ExpressionAttributeValues: values,
	}); err != nil {
		return fmt.Errorf("store: set job status: %w", err)
	}
	return nil
}
