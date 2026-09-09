// Package auth issues and verifies the short-lived session token a
// participant gets when they redeem their code.
//
// This is deliberately not a JWT library. The token carries one claim -- the
// participant's code -- for a few hours, over HTTPS, for a single-day event.
// An HMAC over "code:expiry" is the whole requirement; a dependency with an
// algorithm-confusion history is not an improvement at this size.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// TTL is how long a session lasts. Comfortably longer than a session day, so
// nobody is logged out mid-workshop, and short enough that a token found on a
// borrowed phone next week is useless.
const TTL = 12 * time.Hour

var (
	ErrMalformed = errors.New("auth: malformed token")
	ErrExpired   = errors.New("auth: token expired")
	ErrSignature = errors.New("auth: bad signature")
)

var enc = base64.RawURLEncoding

// Signer holds the shared secret.
type Signer struct{ secret []byte }

// NewSigner returns a Signer. The secret must be identical across every
// instance of the API function, or tokens issued by one are rejected by the
// next -- which under Lambda concurrency looks like random logouts.
func NewSigner(secret string) (*Signer, error) {
	if len(secret) < 16 {
		return nil, fmt.Errorf("auth: secret too short (%d bytes)", len(secret))
	}
	return &Signer{secret: []byte(secret)}, nil
}

func (s *Signer) mac(payload string) string {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte(payload))
	return enc.EncodeToString(m.Sum(nil))
}

// Sign issues a token for a participant code.
func (s *Signer) Sign(code string, now time.Time) string {
	payload := code + ":" + strconv.FormatInt(now.Add(TTL).Unix(), 10)
	b := enc.EncodeToString([]byte(payload))
	return b + "." + s.mac(b)
}

// Verify returns the code carried by a valid, unexpired token.
func (s *Signer) Verify(token string, now time.Time) (string, error) {
	body, sig, ok := strings.Cut(token, ".")
	if !ok {
		return "", ErrMalformed
	}

	// Constant time: a timing oracle here would leak the signature byte by
	// byte, and the cost of doing it right is nothing.
	if !hmac.Equal([]byte(sig), []byte(s.mac(body))) {
		return "", ErrSignature
	}

	raw, err := enc.DecodeString(body)
	if err != nil {
		return "", ErrMalformed
	}
	code, expStr, ok := strings.Cut(string(raw), ":")
	if !ok || code == "" {
		return "", ErrMalformed
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil {
		return "", ErrMalformed
	}
	if now.Unix() > exp {
		return "", ErrExpired
	}
	return code, nil
}

// Bearer pulls a token out of an Authorization header.
func Bearer(header string) string {
	const p = "bearer "
	if len(header) > len(p) && strings.EqualFold(header[:len(p)], p) {
		return strings.TrimSpace(header[len(p):])
	}
	return ""
}
