package render

// Single fixed template. No participant or model value reaches it except as
// data, and html/template escapes every insertion by context.
const pageHTML = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.BusinessName}}</title>
<meta name="description" content="{{.Tagline}}">
<meta property="og:title" content="{{.BusinessName}}">
<meta property="og:description" content="{{.Tagline}}">
<style>
:root{--ink:#14181f;--muted:#5d6674;--line:#e2e6ec;--bg:#fbfbf9;--accent:#12694a;--card:#fff}
@media(prefers-color-scheme:dark){:root{--ink:#eef1f5;--muted:#98a2b3;--line:#27303c;--bg:#0e1218;--accent:#4fbf8e;--card:#151b23}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:28px 20px 96px}
header{padding:8px 0 24px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:clamp(28px,7vw,38px);line-height:1.15;letter-spacing:-.02em}
.tagline{margin:10px 0 0;color:var(--muted);font-size:17px}
.about{margin:22px 0 0}
h2{margin:34px 0 12px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
ul{list-style:none;margin:0;padding:0}
li{display:flex;justify-content:space-between;gap:16px;align-items:baseline;padding:14px 0;border-bottom:1px solid var(--line)}
li:last-child{border-bottom:0}
.name{font-weight:600}
.note{display:block;color:var(--muted);font-size:14px;font-weight:400;margin-top:2px}
.price{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--accent);font-weight:600}
.meta{margin:26px 0 0;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:15px}
.meta div+div{margin-top:6px}
.cta{position:fixed;left:0;right:0;bottom:0;padding:12px 20px calc(12px + env(safe-area-inset-bottom));background:var(--bg);border-top:1px solid var(--line)}
.cta a{display:block;max-width:520px;margin:0 auto;background:var(--accent);color:#fff;text-align:center;text-decoration:none;font-weight:600;padding:15px;border-radius:10px}
footer{margin-top:28px;color:var(--muted);font-size:12.5px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>{{.Headline}}</h1>
    {{with .Tagline}}<p class="tagline">{{.}}</p>{{end}}
  </header>

  {{with .About}}<p class="about">{{.}}</p>{{end}}

  {{with .Products}}
  <h2>Menu &amp; Harga</h2>
  <ul>
    {{range .}}
    <li>
      <span class="name">{{.Name}}{{with .Note}}<span class="note">{{.}}</span>{{end}}</span>
      <span class="price">{{.Price}}</span>
    </li>
    {{end}}
  </ul>
  {{end}}

  {{if or .Address .Hours}}
  <div class="meta">
    {{with .Address}}<div>{{.}}</div>{{end}}
    {{with .Hours}}<div>{{.}}</div>{{end}}
  </div>
  {{end}}

  <footer>{{.BusinessName}} &middot; {{.Year}}<br>Dibuat di AIMPACT bersama IA-ITB Pengda Jambi</footer>
</div>

<div class="cta">
  <a href="{{.WhatsAppLink}}" rel="noopener">{{if .CTALabel}}{{.CTALabel}}{{else}}Pesan via WhatsApp{{end}}</a>
</div>
</body>
</html>
`
