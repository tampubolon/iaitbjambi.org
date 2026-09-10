#!/usr/bin/env python3
"""Warms the queue consumer before the room starts submitting.

Cloudflare Queues does not begin at max_concurrency. It starts at one worker
and ramps as it notices the backlog is not clearing, which measurement on
2026-09-10 put at roughly 90-105s to reach full speed. A room that all submits
at once therefore spends its first minute and a half being served by a handful
of workers, and every participant's wait includes that ramp.

This buys some of it back by giving the consumer a backlog to react to before
the real one arrives.

What it does NOT do: hold the consumer warm indefinitely. The same
measurement showed concurrency decaying to zero within about a minute of the
queue emptying (9.00 -> 3.33 -> 0.00 over two minutes). Warmth is perishable,
so timing matters more than volume:

    run this 60-90s before you tell the room to submit

Run it too early and the consumer has scaled back down by the time it matters.
Use --hold to keep firing if the opening slips.

Honest accounting: one wave lifts the consumer to roughly half of
max_concurrency, not all of it, so it recovers something like half the ramp —
call it 45-60s off the front of the session for about a dollar. It is not a
throughput change; see max_concurrency in wrangler.toml for that.

These jobs are real generations billed at the normal rate, and they consume
the reserve codes' allowance rather than any participant's.

    python3 prewarm.py                # one wave, then exit
    python3 prewarm.py --hold 120     # keep the queue busy for two minutes
    python3 prewarm.py --wave 8       # smaller/cheaper wave
"""
import argparse
import csv
import json
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://aimpact.iaitbjambi.org"
CSV = Path(__file__).parent / "seed/participant-codes.csv"

# The tail of the code list is held back from participants for exactly this.
# Whoever runs the registration desk must not hand these out.
RESERVE = 20

# Cloudflare blocks Python-urllib on browser signature (error 1010).
UA = ("Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36")

# Deliberately dull, and named so a stray page is recognisable as ours if one
# is ever looked at. The content does not matter; occupying a slot does.
PROMPT = ("Warung Uji Coba Panitia AIMPACT di Jambi. Menu percobaan "
          "Rp10.000. Buka setiap hari. WhatsApp 0800-0000-0000.")

# Measured mean for a Haiku 4.5 page, used only for the cost estimate.
COST_PER_GEN = 0.052


def _req(path, body=None, token=None):
    headers = {"user-agent": UA}
    if body is not None:
        headers["content-type"] = "application/json"
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def reserve_codes():
    with CSV.open() as fh:
        codes = [row["code"] for row in csv.DictReader(fh)]
    if len(codes) <= RESERVE:
        raise SystemExit(f"{CSV} holds {len(codes)} codes; need more than {RESERVE}")
    return codes[-RESERVE:]


def redeem_all(codes):
    """Redeem in small waves; resolving one host from 200 threads at once
    exhausts the local DNS resolver and fails redeems for no good reason."""
    tokens = {}

    def one(c):
        try:
            tokens[c] = _req("/api/redeem", {"code": c})["token"]
        except Exception as err:
            print(f"  redeem {c} failed: {err}")

    for i in range(0, len(codes), 10):
        ts = [threading.Thread(target=one, args=(c,)) for c in codes[i : i + 10]]
        [t.start() for t in ts]
        [t.join() for t in ts]
    return tokens


def fire(tokens, n):
    """Submit n jobs and return, without waiting for them. The point is to
    leave a backlog behind, not to collect pages."""
    sent = 0
    lock = threading.Lock()

    def one(token):
        nonlocal sent
        try:
            _req("/api/generate", {"prompt": PROMPT}, token)
            with lock:
                sent += 1
        except urllib.error.HTTPError as err:
            # 429 means that code has spent its fifteen; anything else is
            # worth seeing before the session rather than during it.
            print(f"  submit failed: HTTP {err.code}")
        except Exception as err:
            print(f"  submit failed: {err}")

    chosen = list(tokens.values())[:n]
    ts = [threading.Thread(target=one, args=(t,)) for t in chosen]
    [t.start() for t in ts]
    [t.join() for t in ts]
    return sent


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--wave", type=int, default=14,
                    help="jobs per wave (default 14, slightly above max_concurrency)")
    ap.add_argument("--hold", type=int, default=0,
                    help="keep firing waves for this many seconds")
    args = ap.parse_args()

    codes = reserve_codes()
    print(f"  reserve codes: {len(codes)} (last {RESERVE} rows, not for participants)")
    tokens = redeem_all(codes)
    print(f"  redeemed {len(tokens)}/{len(codes)}\n")
    if not tokens:
        raise SystemExit("no reserve code could be redeemed; check the system is up")

    start = time.time()
    total = 0
    while True:
        sent = fire(tokens, args.wave)
        total += sent
        print(f"  +{sent} jobs queued  (total {total}, {time.time() - start:.0f}s)")
        # A wave of ~14 keeps 11 slots busy for roughly 20s; re-fire just
        # before it drains so the backlog never reaches zero.
        if time.time() - start >= args.hold:
            break
        time.sleep(18)

    print()
    print(f"  queued {total} warm-up jobs, ~${total * COST_PER_GEN:.2f}")
    print("  consumer stays warm ~1 min after the backlog clears —")
    print("  open the floor now.")


if __name__ == "__main__":
    main()
