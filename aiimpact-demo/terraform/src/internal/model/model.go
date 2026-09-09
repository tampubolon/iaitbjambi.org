// Package model holds the types shared between the API and the worker.
package model

import "time"

// JobStatus tracks a generation request through the queue.
type JobStatus string

const (
	StatusQueued  JobStatus = "queued"
	StatusRunning JobStatus = "running"
	StatusDone    JobStatus = "done"
	StatusError   JobStatus = "error"
)

// Job is one generation request. Rows expire via the table's TTL attribute.
type Job struct {
	JobID     string    `dynamodbav:"job_id"    json:"job_id"`
	Code      string    `dynamodbav:"code"      json:"-"`
	Slug      string    `dynamodbav:"slug"      json:"slug"`
	Status    JobStatus `dynamodbav:"status"    json:"status"`
	URL       string    `dynamodbav:"url"       json:"url,omitempty"`
	Message   string    `dynamodbav:"message"   json:"message,omitempty"`
	CreatedAt time.Time `dynamodbav:"created_at" json:"created_at"`
	TTL       int64     `dynamodbav:"ttl"       json:"-"`
}

// Participant is one redeemed code. GenerationCount enforces the spend cap.
type Participant struct {
	Code            string    `dynamodbav:"code"             json:"-"`
	Slug            string    `dynamodbav:"slug"             json:"slug"`
	BusinessName    string    `dynamodbav:"business_name"    json:"business_name"`
	WhatsApp        string    `dynamodbav:"wa_number"        json:"wa_number"`
	GenerationCount int       `dynamodbav:"generation_count" json:"generation_count"`
	CreatedAt       time.Time `dynamodbav:"created_at"       json:"created_at"`
}

// Product is one item on the page.
type Product struct {
	Name  string `json:"name"`
	Price string `json:"price"`
	Note  string `json:"note,omitempty"`
}

// SiteContent is what the model returns. It is deliberately a set of fields,
// never markup: the renderer builds the HTML, so no model output can reach the
// page as executable content. See README section 5.1.
type SiteContent struct {
	BusinessName string    `json:"business_name"`
	Headline     string    `json:"headline"`
	Tagline      string    `json:"tagline"`
	About        string    `json:"about"`
	Products     []Product `json:"products"`
	CTALabel     string    `json:"cta_label"`
	WhatsApp     string    `json:"wa_number"`
	Address      string    `json:"address,omitempty"`
	Hours        string    `json:"hours,omitempty"`
}
