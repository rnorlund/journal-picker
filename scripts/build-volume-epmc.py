#!/usr/bin/env python3
"""Measure per-journal publication volume for a field, using Europe PMC only.

Why this exists
---------------
build-catalog.py measures volume with one OpenAlex `group_by` call per topic.
That is fast per call but credit-metered, and ten fields at 100-300 topics each
exhausted the allowance — three machines all sat sleeping ~19 hours waiting for
a reset.

Europe PMC has no aggregation endpoint, so we page articles and count journals
ourselves. That sounds worse and is actually better here: pageSize is 1,000,
cursorMark pages indefinitely, and none of it is metered.

We sample rather than page a field exhaustively. Ranking journals by in-field
output converges long before the tail does — 3,000 articles already surfaced
389 distinct dental journals — so SAMPLE_TARGET articles is plenty to rank
venues, and paging all 470,000 dental articles would take ~105 minutes to
slightly reorder the bottom of the list.

What this does NOT produce: h-index, citedness, and "core venue" status exist
only in OpenAlex. build-catalog.py still enriches from there, but enrichment is
batched 50 ISSNs per call — roughly a tenth the credit cost of the topic sweep
this replaces.

Usage
-----
    FIELD=dental-oral python3 scripts/build-volume-epmc.py

Reads  data/fields/<FIELD>.json  (for the query terms)
Writes data/.cache/volume-epmc--<FIELD>.json
"""

import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
EMAIL = os.environ.get("JOURNALPICKER_EMAIL", "").strip() or "journal-picker@example.org"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(DATA, ".cache")

FIELD = os.environ.get("FIELD", "").strip()
YEAR_FROM = int(os.environ.get("YEAR_FROM", "2020"))
YEAR_TO = int(os.environ.get("YEAR_TO", "2026"))
PAGE_SIZE = 1000
SAMPLE_TARGET = int(os.environ.get("SAMPLE_TARGET", "40000"))
MIN_ARTICLES = 5          # ignore journals with a trivial presence in the field
THROTTLE = 0.25
MAX_TRIES = 5


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


_last = [0.0]


def fetch(params, tries=MAX_TRIES):
    delay = 2.0
    for attempt in range(tries):
        gap = time.time() - _last[0]
        if gap < THROTTLE:
            time.sleep(THROTTLE - gap + random.uniform(0, 0.05))
        try:
            url = EPMC + "?" + urllib.parse.urlencode(dict(params, email=EMAIL))
            req = urllib.request.Request(url, headers={
                "User-Agent": "journalPicker/1.0 (mailto:%s)" % EMAIL,
                "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                body = json.load(r)
            _last[0] = time.time()
            return body
        except urllib.error.HTTPError as err:
            _last[0] = time.time()
            if err.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                log("      HTTP %d -- retrying in %.0fs" % (err.code, delay))
                time.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            raise
        except Exception:
            _last[0] = time.time()
            if attempt < tries - 1:
                time.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            raise


def field_query(spec):
    """An OR of the terms that actually identify the field.

    Signals and populations only. Methods are deliberately excluded: every
    field's method lexicon contains generic research vocabulary --
    "systematic review", "cohort study", "machine learning", "randomised
    controlled trial" -- which matches all of medicine. Including them made the
    dental query match 2,990,012 articles instead of the ~470,000 that actually
    mention dentistry, i.e. it stopped describing a field at all.

    Signals ("dental", "periodontal", "caries") and populations ("dental
    caries", "oral cancer") are field-defining by construction, because they are
    what the detector uses to recognise the field in a manuscript.
    """
    terms = set()
    for pair in (spec.get("populations") or []):
        probe = pair[1] if len(pair) > 1 else pair[0]
        if probe and len(probe) > 4:
            terms.add(probe.lower())
    for sig in (spec.get("signals") or []):
        if len(sig) > 4:
            terms.add(sig.lower())

    quoted = ['"%s"' % t if " " in t else t for t in sorted(terms)]
    return "(%s) AND (FIRST_PDATE:[%d TO %d])" % (
        " OR ".join(quoted), YEAR_FROM, YEAR_TO)


def norm_issn(s):
    m = "".join(c for c in str(s or "").upper() if c.isdigit() or c == "X")
    return "%s-%s" % (m[:4], m[4:]) if len(m) == 8 else None


def main():
    if not FIELD:
        raise SystemExit("set FIELD=<id>")
    spec_path = os.path.join(DATA, "fields", "%s.json" % FIELD)
    if not os.path.exists(spec_path):
        raise SystemExit("no field definition at %s" % spec_path)
    with open(spec_path) as fh:
        spec = json.load(fh)

    query = field_query(spec)
    log("FIELD %s" % FIELD)
    log("  query is %d chars, %d OR-terms" % (len(query), query.count(" OR ") + 1))

    counts = Counter()
    names = {}
    issn_of = {}
    seen_articles = 0
    cursor = "*"
    page = 0

    first = fetch({"query": query, "format": "json", "pageSize": 1,
                   "resultType": "idlist", "cursorMark": "*"})
    total = first.get("hitCount", 0)
    log("  %s articles match this field in Europe PMC" % f"{total:,}")
    log("  sampling up to %s of them" % f"{SAMPLE_TARGET:,}")

    t0 = time.time()
    while seen_articles < min(SAMPLE_TARGET, total):
        data = fetch({"query": query, "format": "json", "pageSize": PAGE_SIZE,
                      "resultType": "lite", "cursorMark": cursor})
        rows = data.get("resultList", {}).get("result", [])
        if not rows:
            break
        for r in rows:
            title = r.get("journalTitle")
            if not title:
                continue
            issn = norm_issn(r.get("journalIssn"))
            key = issn or "t:" + title.lower()
            counts[key] += 1
            names.setdefault(key, title)
            if issn:
                issn_of[key] = issn
        seen_articles += len(rows)
        page += 1
        nxt = data.get("nextCursorMark")
        if not nxt or nxt == cursor:
            break
        cursor = nxt
        if page % 5 == 0:
            rate = seen_articles / max(time.time() - t0, 1)
            log("    page %3d  %7s articles  %5d journals  %.0f art/s"
                % (page, f"{seen_articles:,}", len(counts), rate))

    kept = {k: c for k, c in counts.items() if c >= MIN_ARTICLES}
    elapsed = time.time() - t0

    out = {
        "field": FIELD,
        "source": "Europe PMC",
        "generated": "2026-08-24",
        "query_hit_count": total,
        "articles_sampled": seen_articles,
        "sample_fraction": round(seen_articles / total, 4) if total else None,
        "years": [YEAR_FROM, YEAR_TO],
        "min_articles": MIN_ARTICLES,
        "journals": [
            {"issn": issn_of.get(k), "title": names[k], "articles": c}
            for k, c in sorted(kept.items(), key=lambda kv: -kv[1])
        ],
    }
    os.makedirs(CACHE, exist_ok=True)
    dest = os.path.join(CACHE, "volume-epmc--%s.json" % FIELD)
    with open(dest, "w") as fh:
        json.dump(out, fh)

    log("\n  sampled %s of %s articles (%.0f%%) in %.0fs"
        % (f"{seen_articles:,}", f"{total:,}",
           100.0 * seen_articles / max(total, 1), elapsed))
    log("  %d journals with >= %d articles (from %d seen)"
        % (len(kept), MIN_ARTICLES, len(counts)))
    log("  wrote %s" % dest)
    log("\n  top 15 venues:")
    for row in out["journals"][:15]:
        log("    %6d  %-10s %s" % (row["articles"], row["issn"] or "-", row["title"][:52]))


if __name__ == "__main__":
    main()
