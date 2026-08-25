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

We sample rather than page a field exhaustively, but the sample has to be large
enough for the tail. At 40,000 of 1.4 million dental articles (3%) this found
509 journals where the OpenAlex-built catalog had 1,122: the two agreed on the
leaders — BMC Oral Health first, Cureus second in both — but a journal needs
substantial output to clear the threshold in a 3% sample, so half the tail was
missing. 120,000 with a lower threshold recovers much more of it and still
costs nothing but time.

Even so, expect a Europe PMC catalog to be somewhat thinner and more
PubMed-centric than an OpenAlex one; venues poorly indexed in PubMed are
under-represented. Catalogs record which source built them.

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
SAMPLE_TARGET = int(os.environ.get("SAMPLE_TARGET", "120000"))
MIN_ARTICLES = 3          # ignore journals with a trivial presence in the field
THROTTLE = 0.25
MAX_TRIES = 8


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
    return " OR ".join(quoted)


def norm_issn(s):
    """First real ISSN from a possibly multi-valued field.

    Europe PMC packs several into one string ("0976-4879; 0975-7406; "), which
    stripped down to 16 digits and failed an 8-character check, silently
    dropping 58% of journals from the dental sweep.
    """
    for part in str(s or "").replace("|", ";").replace("/", ";").split(";"):
        m = "".join(c for c in part.upper() if c.isdigit() or c == "X")
        if len(m) == 8:
            return "%s-%s" % (m[:4], m[4:])
    return None


def main():
    if not FIELD:
        raise SystemExit("set FIELD=<id>")
    spec_path = os.path.join(DATA, "fields", "%s.json" % FIELD)
    if not os.path.exists(spec_path):
        raise SystemExit("no field definition at %s" % spec_path)
    with open(spec_path) as fh:
        spec = json.load(fh)

    base_terms = field_query(spec)
    query = "(%s) AND (FIRST_PDATE:[%d TO %d])" % (base_terms, YEAR_FROM, YEAR_TO)

    # A completed sweep costs ~40 minutes, so never redo one. The catalog step
    # that consumes it has failed and been rerun several times; repeating the
    # sweep each time would have wasted hours.
    dest_existing = os.path.join(CACHE, "volume-epmc--%s.json" % FIELD)
    if os.path.exists(dest_existing) and not os.environ.get("FORCE"):
        with open(dest_existing) as fh:
            prev = json.load(fh)
        if len(prev.get("journals") or []) >= 50:
            log("FIELD %s: reusing existing sweep (%d journals, %s articles). "
                "FORCE=1 to redo."
                % (FIELD, len(prev["journals"]), f"{prev.get('articles_sampled', 0):,}"))
            return

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

    # Slice by publication year rather than paging one query deep.
    #
    # cursorMark pages indefinitely in principle, but Europe PMC starts
    # returning 504s and 502s around page 20-30 because a deep cursor is
    # expensive server-side. Splitting the same span into one query per year
    # keeps every cursor shallow — six pages instead of forty — for identical
    # coverage, and a failure now costs one year rather than the whole sweep.
    years = list(range(YEAR_TO, YEAR_FROM - 1, -1))
    per_year = max(PAGE_SIZE, SAMPLE_TARGET // len(years))
    log("  slicing by year: %d years, up to %s articles each"
        % (len(years), f"{per_year:,}"))

    t0 = time.time()
    for yr in years:
        if seen_articles >= SAMPLE_TARGET:
            break
        yq = "(%s) AND (FIRST_PDATE:[%d TO %d])" % (base_terms, yr, yr)
        cursor = "*"
        got_year = 0
        while got_year < per_year and seen_articles < SAMPLE_TARGET:
            try:
                data = fetch({"query": yq, "format": "json", "pageSize": PAGE_SIZE,
                              "resultType": "lite", "cursorMark": cursor})
            except Exception as err:
                log("    %d: giving up after %s articles (%s)"
                    % (yr, f"{got_year:,}", type(err).__name__))
                break
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
            got_year += len(rows)
            seen_articles += len(rows)
            page += 1
            nxt = data.get("nextCursorMark")
            if not nxt or nxt == cursor:
                break
            cursor = nxt
        rate = seen_articles / max(time.time() - t0, 1)
        log("    %d  %7s articles  %5d journals  %.0f art/s"
            % (yr, f"{seen_articles:,}", len(counts), rate))

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
