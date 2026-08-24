#!/usr/bin/env python3
"""Turn the full field catalogs into slim ones for the web, and attach timing.

The builder keeps everything OpenAlex and DOAJ return, which is right for a
build artefact and wrong for a page load: the four full catalogs come to ~19 MB,
and browse mode loads all of them. Most of that weight is fields the UI never
reads (per-year counts, every APC currency, long alternate-title lists).

This drops the app to what it actually renders, folds in the PubMed review-time
figures, and writes the served files. Run it after build-catalog.py and
build-timing.py.

    python3 scripts/slim-catalogs.py

In:  data/catalogs-full/<field>.json, data/timing.json
Out: data/journals.json (brain imaging), data/catalogs/<field>.json,
     data/catalogs/index.json
"""

import glob
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
FULL = os.path.join(DATA, "catalogs-full")
OUT = os.path.join(DATA, "catalogs")

# Only what the UI renders. Anything not here is a build-time detail.
KEEP = [
    "id", "display_name", "abbreviated_title", "issn", "issn_l",
    "type", "kind", "publisher", "homepage_url",
    "is_oa", "is_in_doaj", "is_core", "is_preprint_repository",
    "apc_usd", "apc_known", "apc_amount", "apc_currency", "apc_source",
    "doaj_apc_url", "oa_model",
    "works_count", "h_index", "two_yr_mean_citedness",
    "field", "field_works", "field_share", "neuro_works", "neuro_share",
]
MAX_ALT_TITLES = 3      # enough for the citation gazetteer to work
MAX_TOPICS = 5          # shown as "journal's main topics"


def norm_issn(s):
    m = "".join(c for c in str(s or "").upper() if c.isdigit() or c == "X")
    return "%s-%s" % (m[:4], m[4:]) if len(m) == 8 else None


def load_timing():
    path = os.path.join(DATA, "timing.json")
    if not os.path.exists(path):
        print("  no timing.json -- catalogs will ship without review times")
        return {}
    with open(path) as fh:
        payload = json.load(fh)
    by = {}
    for issn, t in (payload.get("by_issn") or {}).items():
        k = norm_issn(issn)
        if k:
            by[k] = t
    print("  timing: %d journals" % len(by))
    return by


# Approximate, only for putting non-USD prices on one scale for filtering.
USD_PER = {"USD": 1.0, "EUR": 1.08, "GBP": 1.27, "CHF": 1.12, "JPY": 0.0065,
           "CAD": 0.73, "AUD": 0.66, "SEK": 0.095, "DKK": 0.145, "NOK": 0.093,
           "BRL": 0.18, "INR": 0.012, "CNY": 0.14, "PLN": 0.25, "TRY": 0.03,
           "ZAR": 0.055, "MXN": 0.058, "KRW": 0.00072, "TWD": 0.031}


def to_usd(amount, currency):
    if amount is None:
        return None
    rate = USD_PER.get((currency or "USD").upper())
    return int(round(amount * rate)) if rate else None


def repair_apc(j):
    """Recompute apc_usd from the best available source.

    Older catalogs stored OpenAlex's raw apc_usd, which is null both for "no
    charge" and "not recorded". Where DOAJ recorded an explicit answer, use it.
    """
    if j.get("doaj_has_apc") is False:
        return 0
    price = j.get("doaj_apc_price")
    if price is not None:
        usd = to_usd(price, j.get("doaj_apc_currency"))
        if usd is not None:
            return usd
    usd = to_usd(j.get("apc_amount"), j.get("apc_currency"))
    if usd is not None:
        return usd
    return j.get("apc_usd")


def slim_record(j, timing):
    out = {k: j[k] for k in KEEP if k in j and j[k] is not None}

    apc = repair_apc(j)
    if apc is not None:
        out["apc_usd"] = apc
        out["apc_known"] = True
    else:
        out.pop("apc_usd", None)
        out["apc_known"] = False

    # oa_model must agree with the repaired price.
    if out.get("oa_model") == "oa-apc-unknown" and apc is not None:
        out["oa_model"] = "diamond" if apc == 0 else ("gold" if j.get("is_oa") else "hybrid")
    elif out.get("oa_model") in ("gold", "hybrid") and apc == 0:
        out["oa_model"] = "diamond"

    alts = [a for a in (j.get("alternate_titles") or []) if a][:MAX_ALT_TITLES]
    if alts:
        out["alternate_titles"] = alts

    topics = j.get("topics") or []
    if topics:
        out["topics"] = [{"id": t.get("id"), "name": t.get("name"),
                          "count": t.get("count")}
                         for t in topics[:MAX_TOPICS]]

    # Attach review timing by any of the journal's ISSNs.
    #
    # Guard against a real artefact: some venues report medians of a few days.
    # Physics of Life Reviews reads as 3 days over 150 articles, Trends in
    # Neurosciences as 10. Those are commissioned reviews, or publishers that
    # deposit the revision date as "received" -- PubMed does not always type
    # such content as Review, so the article-type filter cannot catch it. No
    # genuine external peer review of a research paper completes in under three
    # weeks, so anything faster is flagged rather than shown as a headline
    # number: better to say the dates look unreliable than to send someone to a
    # journal expecting a two-day decision.
    for issn in [j.get("issn_l")] + list(j.get("issn") or []):
        k = norm_issn(issn)
        if k and k in timing:
            t = timing[k]
            out["review"] = {
                "n": t["n"],
                "median": t["review_median"],
                "p25": t["review_p25"],
                "p75": t["review_p75"],
            }
            if t["review_median"] < 21:
                out["review"]["suspect"] = True
            if t.get("to_pub_median") is not None:
                out["review"]["to_pub"] = t["to_pub_median"]
            break
    return out


def main():
    timing = load_timing()
    os.makedirs(OUT, exist_ok=True)

    paths = sorted(glob.glob(os.path.join(FULL, "*.json")))
    if not paths:
        raise SystemExit("no catalogs in %s" % FULL)

    # Field display names, so the browse selector can label itself without
    # fetching all sixteen catalogs just to read their titles.
    names = {}
    for fp in glob.glob(os.path.join(DATA, "fields", "*.json")):
        base = os.path.basename(fp)
        if base == "index.json" or base.endswith(".topics.json"):
            continue
        try:
            with open(fp) as fh:
                spec = json.load(fh)
            names[spec.get("id") or base[:-5]] = spec.get("name")
        except Exception:
            pass

    fields, total_before, total_after = [], 0, 0

    for path in paths:
        field = os.path.basename(path)[:-5]
        with open(path) as fh:
            payload = json.load(fh)

        journals = [slim_record(j, timing) for j in payload.get("journals", [])]
        # Keep only venues you can actually submit to, plus flagged repositories
        # (the UI hides those by default but explains why).
        with_review = sum(1 for j in journals if "review" in j)

        slim = {
            "generated": payload.get("generated"),
            "field": field,
            "source": "OpenAlex + DOAJ; review times from PubMed histories",
            "journals": journals,
        }
        dest = (os.path.join(DATA, "journals.json") if field == "brain-imaging"
                else os.path.join(OUT, "%s.json" % field))
        with open(dest, "w") as fh:
            json.dump(slim, fh, separators=(",", ":"))

        before = os.path.getsize(path)
        after = os.path.getsize(dest)
        total_before += before
        total_after += after
        fields.append({
            "id": field,
            "name": names.get(field) or field.replace("-", " ").title(),
            "journals": len(journals),
            "submittable": sum(1 for j in journals if j.get("kind") == "journal"),
            "with_review": with_review,
            "bytes": after,
            "path": ("journals.json" if field == "brain-imaging"
                     else "catalogs/%s.json" % field),
        })
        print("  %-16s %5d journals  %5.1f MB -> %4.1f MB  (%d with review times)"
              % (field, len(journals), before / 1048576, after / 1048576, with_review))

    # brain-imaging is served from journals.json, so it is not in this manifest's
    # directory, but the app still needs to know it exists. Each entry carries
    # its own path, so the browse selector can load exactly one catalog.
    # Brain imaging first (the most developed field, and the smallest of the
    # large catalogs), then alphabetically. Sorting by size would make the
    # biggest catalog the default download, which is backwards.
    fields.sort(key=lambda f: (f["id"] != "brain-imaging", f["name"]))
    with open(os.path.join(OUT, "index.json"), "w") as fh:
        json.dump({"fields": fields}, fh, indent=1)

    print("\n  total %.1f MB -> %.1f MB (%.0f%% smaller)"
          % (total_before / 1048576, total_after / 1048576,
             100 * (1 - total_after / total_before)))
    print("  manifest: %d fields, largest %s (%d submittable journals)"
          % (len(fields), fields[0]["id"], fields[0]["submittable"]))


if __name__ == "__main__":
    main()
