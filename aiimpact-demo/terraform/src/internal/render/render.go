// Package render turns model output into a finished page.
//
// The security property this package exists to provide: the model returns
// fields, and only this template turns them into HTML. html/template applies
// contextual escaping, so no value a participant or the model produces can
// become executable content. That is a stronger guarantee than sanitising
// generated markup, which is why the model is never asked for markup at all.
package render

import (
	"bytes"
	"fmt"
	"html/template"
	"strings"

	"github.com/tampubolon/iaitbjambi.org/aiimpact-demo/internal/model"
)

// WhatsAppNumber converts an Indonesian number to the wa.me form.
//
// Local format is what people write (0812...) and what wa.me rejects; it needs
// the country code (62812...). Getting this wrong produces a button that
// silently opens nothing, which is the most common failure in this workflow.
func WhatsAppNumber(raw string) string {
	var digits strings.Builder
	for _, r := range raw {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		}
	}
	n := digits.String()

	switch {
	case n == "":
		return ""
	case strings.HasPrefix(n, "62"):
		return n
	case strings.HasPrefix(n, "0"):
		return "62" + strings.TrimPrefix(n, "0")
	default:
		return "62" + n
	}
}

type view struct {
	model.SiteContent
	WhatsAppLink template.URL
	Year         int
}

var page = template.Must(template.New("page").Parse(pageHTML))

// Page renders content to a complete standalone HTML document.
func Page(c model.SiteContent, year int) ([]byte, error) {
	wa := WhatsAppNumber(c.WhatsApp)
	if wa == "" {
		return nil, fmt.Errorf("render: no usable WhatsApp number in %q", c.WhatsApp)
	}

	text := "Halo, saya ingin memesan."
	link := template.URL("https://wa.me/" + wa + "?text=" + template.URLQueryEscaper(text))

	var buf bytes.Buffer
	if err := page.Execute(&buf, view{SiteContent: c, WhatsAppLink: link, Year: year}); err != nil {
		return nil, fmt.Errorf("render: %w", err)
	}
	return buf.Bytes(), nil
}
