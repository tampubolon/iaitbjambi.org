/**
 * Renders /admin/statistik from the figures in stats.ts.
 *
 * Charts are plain HTML and CSS: the tiket CSP allows no external script, and
 * a dozen bars do not need a library. Every chart has a table view underneath
 * and a native tooltip on each bar, so no number depends on reading a colour.
 */
import type { Bucket, Stats, TestSummary } from "./stats";

interface PageCtx {
  esc: (s: string) => string;
  page: (title: string, body: string, extraHead?: string) => Response;
}

const STYLE = `<style>
.st{--pre:#2a78d6;--post:#eb6834;--one:#12507e;--track:#eef1f5}
.st h2{margin-top:0}
.st .sub{color:var(--muted);font-size:13px;margin:-6px 0 14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.kpi{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:#fff}
.kpi .v{font-size:30px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.kpi .l{font-size:13px;color:var(--muted);margin-top:3px}
.kpi .d{font-size:12.5px;color:var(--ink);margin-top:4px}
.hb{display:grid;grid-template-columns:minmax(110px,34%) 1fr auto;gap:6px 10px;align-items:center;font-size:13.5px}
.hb .lab{color:var(--ink)}
.hb .trk,.qb .trk{height:14px;background:var(--track);border-radius:0 4px 4px 0}
.hb .fil,.qb .fil{height:100%;background:var(--one);border-radius:0 4px 4px 0;min-width:2px}
.hb .fil:hover,.qb .fil:hover,.vb .b:hover{filter:brightness(1.15)}
.hb .val{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.qb{display:grid;gap:10px}
.qb .qt2{font-size:13px;line-height:1.35;margin-bottom:3px}
.qb .ln{display:grid;grid-template-columns:1fr 48px;gap:10px;align-items:center}
.qb .val{font-variant-numeric:tabular-nums;text-align:right;font-weight:600}
.vb{display:flex;align-items:flex-end;gap:6px;height:170px;border-bottom:1px solid #b8c2cf;padding-top:18px}
.vb .g{flex:1;display:flex;align-items:flex-end;justify-content:center;gap:2px;height:100%;min-width:0}
.vb .b{flex:1;max-width:26px;border-radius:4px 4px 0 0;position:relative;min-height:1px}
.vb .b i{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);font:600 10.5px system-ui;
color:var(--ink);font-style:normal;padding-bottom:2px;white-space:nowrap}
.vx{display:flex;gap:6px;font-size:11px;color:var(--muted);margin-top:4px}
.vx span{flex:1;text-align:center;min-width:0;overflow:hidden}
.axis-t{font-size:12px;color:var(--muted);text-align:center;margin-top:2px}
.leg{display:flex;gap:16px;font-size:13px;margin:0 0 8px}
.leg span{display:inline-flex;align-items:center;gap:6px}
.leg i{width:12px;height:12px;border-radius:3px;display:inline-block}
.st details{margin-top:12px;font-size:13px}
.st summary{cursor:pointer;color:var(--brand);font-weight:600}
.st details table{margin-top:8px}
.two{display:grid;gap:22px}
.note{font-size:12.5px;color:var(--muted);line-height:1.5}
@media print{.st summary,.noprint{display:none}.st details{display:block}}
</style>`;

const fmt = (n: number, digits = 1) =>
  n.toLocaleString("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: digits });
const pct = (part: number, whole: number) => (whole ? `${fmt((part / whole) * 100, 0)}%` : "–");

function kpi(value: string, label: string, detail = ""): string {
  return `<div class="kpi"><div class="v">${value}</div><div class="l">${label}</div>${
    detail ? `<div class="d">${detail}</div>` : ""
  }</div>`;
}

function table(c: PageCtx, head: string[], rows: (string | number)[][]): string {
  return `<table><thead><tr>${head.map((h) => `<th>${c.esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows
      .map((r) => `<tr>${r.map((v) => `<td>${c.esc(String(v))}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;
}

function details(c: PageCtx, head: string[], rows: (string | number)[][]): string {
  return `<details><summary>Lihat tabel</summary>${table(c, head, rows)}</details>`;
}

/** Horizontal bars, one series, with the value printed at the end. */
function hbars(
  c: PageCtx,
  items: { label: string; value: number; shown: string }[],
  max: number,
  color = "var(--one)",
): string {
  return `<div class="hb">${items
    .map((i) => {
      const w = max ? Math.max(0, Math.min(100, (i.value / max) * 100)) : 0;
      return `<div class="lab">${c.esc(i.label)}</div>
        <div class="trk"><div class="fil" style="width:${w.toFixed(1)}%;background:${color}"
          title="${c.esc(`${i.label}: ${i.shown}`)}"></div></div>
        <div class="val">${c.esc(i.shown)}</div>`;
    })
    .join("")}</div>`;
}

/** Vertical bars; one or more series per category, colours in fixed order. */
function vbars(
  c: PageCtx,
  categories: string[],
  series: { name: string; color: string; values: number[] }[],
  axisTitle: string,
): string {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const groups = categories
    .map((cat, i) => {
      const bars = series
        .map((s) => {
          const v = s.values[i] ?? 0;
          const h = (v / max) * 100;
          const tip = `${series.length > 1 ? `${s.name}, ` : ""}${axisTitle} ${cat}: ${v}`;
          return `<div class="b" style="height:${h.toFixed(1)}%;background:${
            v ? s.color : "transparent"
          }" title="${c.esc(tip)}">${v ? `<i>${v}</i>` : ""}</div>`;
        })
        .join("");
      return `<div class="g">${bars}</div>`;
    })
    .join("");
  const legend =
    series.length > 1
      ? `<div class="leg">${series
          .map((s) => `<span><i style="background:${s.color}"></i>${c.esc(s.name)}</span>`)
          .join("")}</div>`
      : "";
  return `${legend}<div class="vb" role="img" aria-label="${c.esc(axisTitle)}">${groups}</div>
    <div class="vx">${categories.map((cat) => `<span>${c.esc(cat)}</span>`).join("")}</div>
    <div class="axis-t">${c.esc(axisTitle)}</div>`;
}

function hourChart(c: PageCtx, buckets: Bucket[], what: string): string {
  if (!buckets.length) return `<p class="meta">Belum ada data.</p>`;
  return `${vbars(c, buckets.map((b) => b.label), [
    { name: what, color: "var(--one)", values: buckets.map((b) => b.value) },
  ], "Jam (WIB)")}
  ${details(c, ["Jam (WIB)", what], buckets.map((b) => [b.label, b.value]))}`;
}

function questionCard(c: PageCtx, title: string, t: TestSummary, color: string): string {
  const items = t.questions.map((q, i) => ({
    label: `${i + 1}. ${q.text}`,
    value: q.correct,
    shown: t.count ? pct(q.correct, 1) : "–",
  }));
  const bars = items
    .map((i) => `<div><div class="qt2">${c.esc(i.label)}</div><div class="ln">
      <div class="trk"><div class="fil" style="width:${(Math.min(1, i.value) * 100).toFixed(1)}%;background:${color}"
        title="${c.esc(`${i.label}: ${i.shown}`)}"></div></div>
      <div class="val">${c.esc(i.shown)}</div></div></div>`)
    .join("");
  return `<div>
    <h3 style="font-size:14px;margin:0 0 10px">${c.esc(title)}</h3>
    <div class="qb">${bars}</div>
    ${details(
      c,
      ["No", "Soal", "Jawaban benar"],
      t.questions.map((q, i) => [i + 1, q.text, t.count ? pct(q.correct, 1) : "–"]),
    )}
  </div>`;
}

export function statsPage(c: PageCtx, s: Stats, asOf: string): Response {
  const lab = s.lab;
  const gain = s.paired.postAverage - s.paired.preAverage;
  const maxFunnel = Math.max(1, ...s.funnel.map((f) => f.value));
  const scoreLabels = s.pre.distribution.map((b) => b.label);

  const body = `<div class="wrap wide st">
    <div class="card">
      <h1>Statistik acara</h1>
      <p class="sub">AIMPACT – AI untuk UMKM · data per ${c.esc(asOf)} WIB ·
        hanya peserta aktif (panitia dan tiket yang dibatalkan tidak dihitung)</p>
      <div class="kpis">
        ${kpi(`${s.attended}`, `peserta hadir dari ${s.registered} terdaftar`, pct(s.attended, s.registered))}
        ${kpi(`${lab.websites}`, "website dibuat peserta", `${pct(lab.websites, s.attended)} dari yang hadir`)}
        ${kpi(fmt(s.pre.average), "rata-rata pre-test", `${s.pre.count} peserta`)}
        ${kpi(fmt(s.post.average), "rata-rata post-test", `${s.post.count} peserta`)}
        ${kpi(
          s.paired.count ? `${gain >= 0 ? "+" : ""}${fmt(gain)}` : "–",
          "kenaikan nilai rata-rata",
          `${s.paired.count} peserta ikut kedua tes`,
        )}
      </div>
    </div>

    <div class="card">
      <h2>Alur peserta</h2>
      <p class="sub">Berapa peserta yang sampai di setiap tahap. Persentase dihitung dari jumlah terdaftar.</p>
      ${hbars(
        c,
        s.funnel.map((f) => ({
          label: f.label,
          value: f.value,
          shown: `${f.value} (${pct(f.value, s.registered)})`,
        })),
        maxFunnel,
      )}
      ${details(c, ["Tahap", "Peserta", "Dari terdaftar"],
        s.funnel.map((f) => [f.label, f.value, pct(f.value, s.registered)]))}
    </div>

    <div class="card">
      <h2>Kedatangan peserta</h2>
      <p class="sub">Jumlah check-in per jam. ${s.attended} hadir,
        ${s.registered - s.attended} tidak hadir.</p>
      ${hourChart(c, s.arrivals, "Check-in")}
    </div>

    <div class="card">
      <h2>Pre-test dan post-test</h2>
      <p class="sub">10 soal per tes, nilai 0–100. Soal post-test berbeda dari pre-test:
        pre-test menanyakan konsep, post-test meminta penerapannya.</p>
      <div class="kpis">
        ${kpi(fmt(s.pre.average), "rata-rata pre-test", `median ${fmt(s.pre.median)} · ${s.pre.count} peserta`)}
        ${kpi(fmt(s.post.average), "rata-rata post-test", `median ${fmt(s.post.median)} · ${s.post.count} peserta`)}
        ${kpi(
          s.paired.count ? `${gain >= 0 ? "+" : ""}${fmt(gain)}` : "–",
          `perubahan nilai, ${s.paired.count} peserta ikut kedua tes`,
          s.paired.count ? `${fmt(s.paired.preAverage)} → ${fmt(s.paired.postAverage)}` : "",
        )}
        ${kpi(
          `${s.paired.improved}`,
          "nilainya naik",
          `${s.paired.same} sama · ${s.paired.declined} turun`,
        )}
      </div>
      <h3 style="font-size:14px;margin:18px 0 8px">Sebaran nilai</h3>
      ${vbars(c, scoreLabels, [
        { name: "Pre-test", color: "var(--pre)", values: s.pre.distribution.map((b) => b.value) },
        { name: "Post-test", color: "var(--post)", values: s.post.distribution.map((b) => b.value) },
      ], "Nilai")}
      ${details(c, ["Nilai", "Pre-test (peserta)", "Post-test (peserta)"],
        scoreLabels.map((l, i) => [l, s.pre.distribution[i]?.value ?? 0, s.post.distribution[i]?.value ?? 0]))}
      ${s.postWithoutCheckIn
        ? `<p class="note">${s.postWithoutCheckIn} post-test dikerjakan oleh peserta yang tidak tercatat check-in.</p>`
        : ""}
    </div>

    <div class="card">
      <h2>Jawaban benar per soal</h2>
      <p class="sub">Persentase peserta yang menjawab benar untuk setiap soal. Soal dengan
        persentase rendah menunjukkan materi yang perlu diperjelas.</p>
      <div class="two">
        ${questionCard(c, `Pre-test (${s.pre.count} peserta)`, s.pre, "var(--pre)")}
        ${questionCard(c, `Post-test (${s.post.count} peserta)`, s.post, "var(--post)")}
      </div>
    </div>

    <div class="card">
      <h2>Praktik AIMPACT: membuat website dengan AI</h2>
      <p class="sub">Setiap peserta mendapat ${lab.maxGenerations} jatah prompt;
        satu prompt yang dikirim memakai satu jatah.</p>
      <div class="kpis">
        ${kpi(`${lab.signedIn}`, "peserta masuk lab", pct(lab.signedIn, s.attended) + " dari yang hadir")}
        ${kpi(`${lab.websites}`, "website jadi", pct(lab.websites, lab.signedIn) + " dari yang masuk lab")}
        ${kpi(`${lab.prompts}`, "prompt dikirim",
          lab.websites ? `rata-rata ${fmt(lab.prompts / lab.websites)} per pembuat website` : "")}
        ${kpi(`${lab.failed}`, "pembuatan gagal", `dari ${lab.prompts} prompt`)}
        ${kpi(`${lab.attendedWithoutWebsite}`, "hadir tetapi belum membuat website")}
      </div>
      <h3 style="font-size:14px;margin:18px 0 8px">Jatah prompt yang dipakai per peserta</h3>
      ${vbars(c, lab.slotsUsed.map((b) => b.label), [
        { name: "Peserta", color: "var(--one)", values: lab.slotsUsed.map((b) => b.value) },
      ], "Prompt yang dipakai")}
      ${details(c, ["Prompt dipakai", "Peserta"], lab.slotsUsed.map((b) => [b.label, b.value]))}
      <h3 style="font-size:14px;margin:18px 0 8px">Prompt dikirim per jam</h3>
      ${hourChart(c, lab.builds, "Prompt")}
    </div>

    <div class="card note">
      <b>Catatan.</b> "Masuk lab" berarti peserta memasukkan kodenya di aimpact.iaitbjambi.org.
      "Website jadi" berarti halamannya sudah terbit. Nilai tes dihitung di server dan hanya
      kiriman pertama yang disimpan. Halaman ini hanya membaca data dan dapat dicetak
      (Ctrl+P) untuk laporan.
    </div>
    <a class="btn ghost noprint" href="/admin">Kembali</a>
  </div>`;

  return c.page("Statistik acara", body, STYLE);
}
