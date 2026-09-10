#!/usr/bin/env python3
"""Measures real token usage for a page generation.

Uses the same system prompt and the same request shape as src/consumer.ts, so
the numbers apply directly to max_concurrency. Reads the key from a file so it
never appears in a command line.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
# Key is read from a file so it never appears in a command line or shell
# history. Create it with: printf %s "$ANTHROPIC_API_KEY" > .ak
KEY = (HERE / ".ak").read_text().strip()
PROMPT_TS = HERE / "src/prompt.ts"

# Pull SYSTEM out of prompt.ts so this measures the prompt that actually ships.
src = PROMPT_TS.read_text(encoding="utf-8")
SYSTEM = re.search(r"export const SYSTEM = `(.*?)`;", src, re.S).group(1)

PROMPTS = [
    "Kedai Es Campur Pak Ujang di Pasar Angso Duo Jambi. Es campur Rp12.000, "
    "es teler Rp15.000, es kelapa muda Rp10.000. Segar dan manis pas. Buka "
    "jam 10 pagi sampai 6 sore. WA 0812-1111-2222.",
    "Percetakan Digital Maju di Kotabaru Jambi. Cetak banner Rp25.000 per "
    "meter, kartu nama Rp50.000 per box, stiker Rp15.000 per lembar. Bisa "
    "desain juga. Buka Senin sampai Sabtu. WA 0813-3333-4444.",
    "Rental Mobil Amanah Jambi. Avanza Rp350.000 per hari, Innova Rp500.000 "
    "per hari, sudah termasuk sopir. Bisa harian atau mingguan. Melayani "
    "24 jam. WA 0852-5555-6666.",
]


def call(user_prompt: str) -> dict:
    body = {
        "model": "claude-opus-5",
        "max_tokens": 16000,
        "output_config": {"effort": "medium"},
        "system": [
            {"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}
        ],
        "messages": [{"role": "user", "content": user_prompt}],
    }
    out = subprocess.run(
        [
            "curl", "-s", "https://api.anthropic.com/v1/messages",
            "-H", f"x-api-key: {KEY}",
            "-H", "anthropic-version: 2023-06-01",
            "-H", "content-type: application/json",
            "--max-time", "300",
            "-d", "@-",
        ],
        input=json.dumps(body),
        capture_output=True,
        text=True,
    ).stdout
    return json.loads(out)


rows = []
for i, p in enumerate(PROMPTS, 1):
    r = call(p)
    if "usage" not in r:
        print(f"  {i}: error {json.dumps(r)[:200]}")
        continue
    u = r["usage"]
    html = "".join(b.get("text", "") for b in r.get("content", []) if b.get("type") == "text")
    rows.append(
        {
            "in": u.get("input_tokens", 0),
            "out": u.get("output_tokens", 0),
            "cache_r": u.get("cache_read_input_tokens", 0),
            "cache_w": u.get("cache_creation_input_tokens", 0),
            "bytes": len(html),
            "stop": r.get("stop_reason"),
        }
    )
    print(f"  {i}: {rows[-1]}")

if not rows:
    sys.exit("no measurements")

out = [r["out"] for r in rows]
mean = sum(out) / len(out)
print()
print(f"  output tokens : min {min(out):,}  max {max(out):,}  mean {mean:,.0f}")
print(f"  page bytes    : mean {sum(r['bytes'] for r in rows)/len(rows):,.0f}")
print(f"  cache reads   : {[r['cache_r'] for r in rows]}")
print()

OUT_TPM = 80_000
DURATION = 30  # measured end-to-end seconds per generation
gen_min = OUT_TPM / mean
conc = gen_min * DURATION / 60
print(f"  at {mean:,.0f} out tok/gen and {DURATION}s each:")
print(f"    rate-limit ceiling      : {gen_min:.0f} generations/min")
print(f"    concurrency to saturate : {conc:.0f}")
print(f"    200 jobs drain in       : {200/gen_min:.1f} min at the ceiling")
for c in (8, 15, 20, 30):
    tpm = (60 * c / DURATION) * mean
    print(
        f"    max_concurrency={c:<3} -> {60*c/DURATION:5.1f} gen/min, "
        f"{tpm:>7,.0f} out tok/min ({tpm/OUT_TPM:>4.0%} of limit), "
        f"200 drain in {200/(60*c/DURATION):4.1f} min"
    )
