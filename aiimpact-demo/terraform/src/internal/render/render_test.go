package render

import (
	"strings"
	"testing"

	"github.com/tampubolon/iaitbjambi.org/aiimpact-demo/internal/model"
)

func TestWhatsAppNumber(t *testing.T) {
	cases := map[string]string{
		"081234567890":     "6281234567890",
		"+62 812-3456-789": "628123456789",
		"62812345678":      "62812345678",
		"0812 3456 7890":   "6281234567890",
		"812345678":        "62812345678",
		"":                 "",
		"abc":              "",
	}
	for in, want := range cases {
		if got := WhatsAppNumber(in); got != want {
			t.Errorf("WhatsAppNumber(%q) = %q, want %q", in, got, want)
		}
	}
}

// The invariant from README section 8: nothing the model or a participant
// supplies may become executable content. These are the payloads a hostile
// prompt would try to smuggle through.
func TestPageEscapesHostileContent(t *testing.T) {
	c := model.SiteContent{
		BusinessName: `<script>alert(1)</script>`,
		Headline:     `Warung "><script>alert(2)</script>`,
		Tagline:      `<img src=x onerror=alert(3)>`,
		About:        `javascript:alert(4)`,
		Products: []model.Product{
			{Name: `<iframe src="evil"></iframe>`, Price: `<b>Rp1</b>`},
		},
		CTALabel: `</a><script>alert(5)</script>`,
		WhatsApp: "081234567890",
	}

	out, err := Page(c, 2026)
	if err != nil {
		t.Fatalf("Page: %v", err)
	}
	got := string(out)

	// No tag from the input may survive as a tag. Escaped angle brackets are
	// the property that matters -- an "onerror=" left as literal text inside
	// &lt;img ...&gt; is inert, so testing for that substring alone would be a
	// false positive rather than a finding.
	for _, forbidden := range []string{
		"<script", "<img", "<iframe", "</a><",
	} {
		if strings.Contains(got, forbidden) {
			t.Errorf("hostile content survived escaping: %q present in output", forbidden)
		}
	}

	// It must still be there, escaped, so the participant sees their own text.
	if !strings.Contains(got, "&lt;script&gt;") {
		t.Error("expected the payload to appear escaped, not dropped")
	}

	// The call to action must still point at wa.me and nowhere else.
	if !strings.Contains(got, `href="https://wa.me/6281234567890`) {
		t.Error("CTA href was not the expected wa.me link")
	}
}

func TestPageRejectsUnusableNumber(t *testing.T) {
	_, err := Page(model.SiteContent{BusinessName: "X", WhatsApp: "no digits"}, 2026)
	if err == nil {
		t.Fatal("expected an error when no WhatsApp number can be derived")
	}
}

func TestPageBuildsWaMeLink(t *testing.T) {
	out, err := Page(model.SiteContent{
		BusinessName: "Nasi Goreng Budi",
		Headline:     "Nasi Goreng Budi",
		WhatsApp:     "0812-3456-7890",
	}, 2026)
	if err != nil {
		t.Fatalf("Page: %v", err)
	}
	if !strings.Contains(string(out), "https://wa.me/6281234567890") {
		t.Error("expected a wa.me link in country-code format")
	}
}
