#!/usr/bin/env python3
"""Compute real per-journal peer-review times from PubMed article histories.

Why this exists
---------------
"How long will review take?" is the question authors ask most and the one no
open dataset answers. Journal Citation Reports is licensed; publisher pages are
inconsistent and usually silent.

But PubMed records carry a per-article <History> block with `received`,
`revised` and `accepted` dates, deposited by the publisher. Median
(accepted - received) over recent articles is therefore a real, reproducible
measure of time in review, computed from primary data rather than from a
journal's marketing copy.

Coverage is partial and varies by publisher -- Elsevier and MDPI deposit these
dates, some societies do not -- so every figure is reported with its sample
size and journals with too few articles are omitted rather than guessed at.

Usage
-----
    python3 scripts/build-timing.py                 # every catalog
    FIELD=dental-oral python3 scripts/build-timing.py
    SHARD=2/3 python3 scripts/build-timing.py       # shard across machines

    NCBI_API_KEY=... raises the NCBI rate limit from 3/s to 10/s.

Output: data/timing.json  (keyed by ISSN, merged across shards)
"""

import glob
import json
import os
import random
import re
import statistics as st
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
MAILTO = "rnorlund@mailbox.sc.edu"
TOOL = "journalPicker"
API_KEY = os.environ.get("NCBI_API_KEY", "").strip() or None

# NCBI allows 3 requests/second unauthenticated, 10 with a key.
THROTTLE = 0.36 if not API_KEY else 0.11
MAX_TRIES = 6
MAX_BACKOFF = 60.0

YEAR_FROM = 2023          # sample window; recent enough to reflect current practice
YEAR_TO = 2026
RETMAX = 150              # articles sampled per journal
MIN_SAMPLE = 8            # below this, report nothing rather than a noisy median
SANE_MAX_DAYS = 1200      # guards against typo'd dates in the source records

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(DATA, ".cache")

FIELD = os.environ.get("FIELD", "").strip() or None


def parse_shard(spec):
    if not spec:
        return (1, 1)
    try:
        i, n = (int(x) for x in spec.split("/", 1))
        if 1 <= i <= n:
            return (i, n)
    except Exception:
        pass
    raise SystemExit("SHARD must look like 2/3 (got %r)" % spec)


SHARD_INDEX, SHARD_COUNT = parse_shard(os.environ.get("SHARD", "").strip())
PROGRESS = os.path.join(
    CACHE, "timing-progress-v2%s.jsonl" % (
        "" if SHARD_COUNT == 1 else "-%dof%d" % (SHARD_INDEX, SHARD_COUNT)))


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


# ------------------------------------------------------------------ http layer

_last = [0.0]


def fetch(url, tries=MAX_TRIES):
    delay = 2.0
    for attempt in range(tries):
        gap = time.time() - _last[0]
        if gap < THROTTLE:
            time.sleep(THROTTLE - gap + random.uniform(0, 0.05))
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "%s/1.0 (mailto:%s)" % (TOOL, MAILTO)})
            with urllib.request.urlopen(req, timeout=90) as r:
                body = r.read().decode("utf-8", "replace")
            _last[0] = time.time()
            return body
        except urllib.error.HTTPError as err:
            _last[0] = time.time()
            if err.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                retry_after = err.headers.get("Retry-After")
                wait = float(retry_after) if (retry_after or "").replace(".", "", 1).isdigit() else delay
                wait = min(wait, MAX_BACKOFF)
                log("      HTTP %d -- backing off %.0fs" % (err.code, wait))
                time.sleep(wait)
                delay = min(delay * 2, MAX_BACKOFF)
                continue
            raise
        except Exception as err:
            _last[0] = time.time()
            if attempt < tries - 1:
                time.sleep(delay)
                delay = min(delay * 2, MAX_BACKOFF)
                continue
            raise


def eutils(endpoint, params):
    params = dict(params, tool=TOOL, email=MAILTO)
    if API_KEY:
        params["api_key"] = API_KEY
    return fetch(EUTILS + endpoint + "?" + urllib.parse.urlencode(params))


# ------------------------------------------------------------------- pubmed i/o

HISTORY_RE = re.compile(
    r'<PubMedPubDate PubStatus="(\w+)">\s*<Year>(\d+)</Year>'
    r'\s*<Month>(\d+)</Month>\s*<Day>(\d+)</Day>')


# Invited and non-research content has no meaningful review period: an invited
# review or an editorial is often accepted the day it arrives. Leaving those in
# made "Seminars in Nuclear Medicine" read as a 6-day journal, which is true of
# its commissioned reviews and useless to someone submitting a research paper.
EXCLUDE_TYPES = ["editorial", "comment", "letter", "news", "review",
                 "published erratum", "biography", "historical article",
                 "practice guideline", "retraction of publication",
                 "case reports", "congress"]


def journal_pmids(issn):
    """Recent research-article PMIDs for one ISSN, excluding invited content."""
    not_clause = " ".join('NOT %s[PT]' % t for t in EXCLUDE_TYPES)
    term = ('"%s"[Journal] AND ("%d"[PDAT] : "%d"[PDAT]) AND journal article[PT] %s'
            % (issn, YEAR_FROM, YEAR_TO, not_clause))
    body = eutils("esearch.fcgi", {
        "db": "pubmed", "retmode": "json", "retmax": RETMAX, "term": term})
    try:
        return json.loads(body)["esearchresult"].get("idlist", [])
    except Exception:
        return []


def article_histories(pmids):
    """Per-article {status: (y, m, d)} maps."""
    out = []
    for i in range(0, len(pmids), 200):
        body = eutils("efetch.fcgi", {
            "db": "pubmed", "retmode": "xml", "id": ",".join(pmids[i:i + 200])})
        for chunk in body.split("<PubmedArticle>")[1:]:
            hist = {}
            for m in HISTORY_RE.finditer(chunk):
                hist[m.group(1)] = (int(m.group(2)), int(m.group(3)), int(m.group(4)))
            if hist:
                out.append(hist)
    return out


def days_between(a, b):
    try:
        return (date(*b) - date(*a)).days
    except Exception:
        return None


def summarise(histories):
    """Median and quartiles for time in review, and acceptance to publication."""
    review, to_pub = [], []
    for h in histories:
        if "received" in h and "accepted" in h:
            d = days_between(h["received"], h["accepted"])
            if d is not None and 0 <= d <= SANE_MAX_DAYS:
                review.append(d)
        if "accepted" in h and "pubmed" in h:
            d = days_between(h["accepted"], h["pubmed"])
            if d is not None and 0 <= d <= SANE_MAX_DAYS:
                to_pub.append(d)

    if len(review) < MIN_SAMPLE:
        return None

    review.sort()
    q = lambda xs, f: xs[min(len(xs) - 1, max(0, int(round(f * (len(xs) - 1)))))]
    return {
        "n": len(review),
        "sampled": len(histories),
        "review_median": int(st.median(review)),
        "review_p25": int(q(review, 0.25)),
        "review_p75": int(q(review, 0.75)),
        "to_pub_median": int(st.median(to_pub)) if len(to_pub) >= MIN_SAMPLE else None,
    }


# ------------------------------------------------------------- catalog + resume

def catalog_journals():
    """(issn, name) for every journal in the requested catalogs, deduped."""
    paths = []
    if FIELD in (None, "brain-imaging"):
        paths.append(os.path.join(DATA, "journals.json"))
    if FIELD is None:
        paths += sorted(glob.glob(os.path.join(DATA, "catalogs", "*.json")))
    elif FIELD != "brain-imaging":
        paths.append(os.path.join(DATA, "catalogs", "%s.json" % FIELD))

    seen, rows = set(), []
    for path in paths:
        if not os.path.exists(path) or os.path.basename(path) == "index.json":
            continue
        with open(path) as fh:
            payload = json.load(fh)
        for j in payload.get("journals", []):
            if j.get("kind") != "journal":
                continue
            issn = j.get("issn_l") or (j.get("issn") or [None])[0]
            if not issn or issn in seen:
                continue
            seen.add(issn)
            rows.append((issn, j.get("display_name") or issn,
                         j.get("field_works") or j.get("neuro_works") or 0))
    # Busiest journals first, so a partial run still covers what most authors see.
    rows.sort(key=lambda r: -r[2])
    return [(i, n) for i, n, _ in rows]


def load_done():
    done = {}
    for path in glob.glob(os.path.join(CACHE, "timing-progress-v2*.jsonl")):
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                done[row["issn"]] = row
    return done


def append_done(row):
    os.makedirs(CACHE, exist_ok=True)
    with open(PROGRESS, "a") as fh:
        fh.write(json.dumps(row) + "\n")


def write_output(done):
    by_issn = {k: v["timing"] for k, v in done.items() if v.get("timing")}
    payload = {
        "generated": "2026-08-23",
        "source": "PubMed article histories via NCBI E-utilities",
        "method": ("median days from publisher-deposited 'received' to 'accepted' "
                   "for research articles published %d-%d" % (YEAR_FROM, YEAR_TO)),
        "min_sample": MIN_SAMPLE,
        "journals_with_timing": len(by_issn),
        "journals_checked": len(done),
        "by_issn": by_issn,
    }
    out = os.path.join(DATA, "timing.json")
    with open(out, "w") as fh:
        json.dump(payload, fh)
    return out, payload


def main():
    os.makedirs(CACHE, exist_ok=True)
    journals = catalog_journals()
    if not journals:
        raise SystemExit("no catalog found -- run build-catalog.py first")

    mine = [j for i, j in enumerate(journals)
            if SHARD_COUNT == 1 or i % SHARD_COUNT == (SHARD_INDEX - 1)]
    done = load_done()
    todo = [(issn, name) for issn, name in mine if issn not in done]

    log("%d journals in catalogs; shard %d/%d owns %d; %d already done, %d to do"
        % (len(journals), SHARD_INDEX, SHARD_COUNT, len(mine), len(done), len(todo)))

    hits = 0
    for i, (issn, name) in enumerate(todo, 1):
        try:
            pmids = journal_pmids(issn)
            timing = summarise(article_histories(pmids)) if pmids else None
        except Exception as err:
            log("  [%4d/%4d] %-40s ERROR %s -- skipping, rerun to retry"
                % (i, len(todo), name[:40], type(err).__name__))
            continue

        append_done({"issn": issn, "name": name, "timing": timing})
        if timing:
            hits += 1
            log("  [%4d/%4d] %-40s n=%3d  review %3dd (IQR %d-%d)"
                % (i, len(todo), name[:40], timing["n"], timing["review_median"],
                   timing["review_p25"], timing["review_p75"]))
        else:
            log("  [%4d/%4d] %-40s no deposited dates" % (i, len(todo), name[:40]))

        if i % 50 == 0:
            out, p = write_output(load_done())
            log("    ... checkpoint: %d journals with timing" % p["journals_with_timing"])

    out, payload = write_output(load_done())
    log("\nwrote %s" % out)
    log("  %d of %d journals have review-time data (%.0f%%)"
        % (payload["journals_with_timing"], payload["journals_checked"],
           100.0 * payload["journals_with_timing"] / max(payload["journals_checked"], 1)))

    fastest = sorted(payload["by_issn"].items(), key=lambda kv: kv[1]["review_median"])
    named = {v["issn"]: v["name"] for v in load_done().values() if v.get("timing")}
    log("\n  fastest 10 (n >= %d):" % MIN_SAMPLE)
    for issn, t in fastest[:10]:
        log("    %4dd  n=%3d  %s" % (t["review_median"], t["n"], named.get(issn, issn)))
    log("  slowest 10:")
    for issn, t in fastest[-10:]:
        log("    %4dd  n=%3d  %s" % (t["review_median"], t["n"], named.get(issn, issn)))


if __name__ == "__main__":
    main()
