package auth

import (
	"errors"
	"testing"
	"time"
)

const secret = "a-secret-long-enough-for-testing"

func TestRoundTrip(t *testing.T) {
	s, err := NewSigner(secret)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	now := time.Now()
	got, err := s.Verify(s.Sign("ABCD12", now), now)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got != "ABCD12" {
		t.Errorf("Verify = %q, want ABCD12", got)
	}
}

func TestRejectsExpired(t *testing.T) {
	s, _ := NewSigner(secret)
	issued := time.Now().Add(-TTL - time.Minute)
	if _, err := s.Verify(s.Sign("ABCD12", issued), time.Now()); !errors.Is(err, ErrExpired) {
		t.Errorf("got %v, want ErrExpired", err)
	}
}

func TestRejectsTamperedPayload(t *testing.T) {
	s, _ := NewSigner(secret)
	now := time.Now()
	tok := s.Sign("ABCD12", now)

	// Swap the payload for another code, keeping the original signature.
	other := s.Sign("ZZZZ99", now)
	forged := other[:len(other)-44] + tok[len(tok)-44:]
	if _, err := s.Verify(forged, now); err == nil {
		t.Error("a forged token verified")
	}
}

func TestRejectsOtherSecret(t *testing.T) {
	a, _ := NewSigner(secret)
	b, _ := NewSigner("a-completely-different-secret-xx")
	now := time.Now()
	if _, err := b.Verify(a.Sign("ABCD12", now), now); !errors.Is(err, ErrSignature) {
		t.Errorf("got %v, want ErrSignature", err)
	}
}

func TestNewSignerRejectsShortSecret(t *testing.T) {
	if _, err := NewSigner("short"); err == nil {
		t.Error("expected an error for a short secret")
	}
}

func TestBearer(t *testing.T) {
	cases := map[string]string{
		"Bearer abc":  "abc",
		"bearer abc":  "abc",
		"BEARER  abc": "abc",
		"abc":         "",
		"":            "",
		"Bearer":      "",
	}
	for in, want := range cases {
		if got := Bearer(in); got != want {
			t.Errorf("Bearer(%q) = %q, want %q", in, got, want)
		}
	}
}
