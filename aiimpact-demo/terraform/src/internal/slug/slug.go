// Package slug turns a business name into the subdomain label its page is
// served from.
//
// The result becomes part of a hostname the owner reads aloud and types into
// WhatsApp, so it has to survive DNS rules (letters, digits, hyphens; 63
// characters; no leading or trailing hyphen) while still being recognisable
// as their own business name.
package slug

import (
	"fmt"
	"strings"
	"unicode"
)

// MaxLen is the DNS label limit. Slugs are held well under it for legibility.
const MaxLen = 40

// Reserved labels never become a participant slug. These either belong to
// infrastructure or would be mistaken for it. Kept in sync with the reserved
// list in cloudfront/rewrite.js.
var reserved = map[string]bool{
	"aimpact": true, "www": true, "api": true, "mail": true, "ftp": true,
	"admin": true, "cdn": true, "smtp": true, "imap": true, "app": true,
	"test": true, "staging": true, "dev": true, "static": true, "assets": true,
}

// Reserved reports whether a label is unavailable regardless of who asks.
func Reserved(s string) bool { return reserved[s] }

// Make normalises a business name into a candidate label.
//
// Returns an error only when nothing usable survives -- a name written
// entirely in punctuation or a script that leaves no ASCII letters. Callers
// should fall back to a generated label in that case rather than reject the
// participant.
func Make(name string) (string, error) {
	var b strings.Builder
	lastHyphen := true // suppresses a leading hyphen

	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastHyphen = false
		case unicode.IsSpace(r), r == '-', r == '_', r == '.', r == '/', r == ',':
			if !lastHyphen && b.Len() > 0 {
				b.WriteRune('-')
				lastHyphen = true
			}
		default:
			// Anything else (punctuation, emoji, non-Latin script) is dropped
			// rather than transliterated: a wrong transliteration is worse to
			// read aloud than a shorter name.
		}
	}

	s := strings.Trim(b.String(), "-")
	if len(s) > MaxLen {
		s = strings.Trim(s[:MaxLen], "-")
	}

	if s == "" {
		return "", fmt.Errorf("slug: %q leaves no usable characters", name)
	}
	// A label may not begin with a digit-only run that looks like an octet, and
	// must not be purely numeric -- both read as infrastructure, not a business.
	if strings.IndexFunc(s, func(r rune) bool { return r >= 'a' && r <= 'z' }) == -1 {
		return "", fmt.Errorf("slug: %q has no letters", name)
	}
	return s, nil
}

// Available reports whether a candidate can be used as-is.
type Available func(candidate string) (bool, error)

// Unique returns the first free label derived from name, appending -2, -3 and
// so on. Two participants naming their warung the same thing is expected, not
// exceptional.
func Unique(name string, free Available) (string, error) {
	base, err := Make(name)
	if err != nil {
		return "", err
	}

	for i := 1; i <= 50; i++ {
		cand := base
		if i > 1 {
			cand = fmt.Sprintf("%s-%d", base, i)
		}
		if Reserved(cand) {
			continue
		}
		ok, err := free(cand)
		if err != nil {
			return "", err
		}
		if ok {
			return cand, nil
		}
	}
	return "", fmt.Errorf("slug: no label free for %q after 50 attempts", name)
}
