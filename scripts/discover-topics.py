#!/usr/bin/env python3
"""Discover OpenAlex topic ids for a new field, for data/fields/<id>.json.

Searches the OpenAlex /topics endpoint for a field's seed terms, then keeps
topics whose subfield is plausible for that field. Prints a reviewable table --
the human picks, this only narrows the candidates.

Usage:  python3 scripts/discover-topics.py dental-oral
"""
import json, os, sys, time, urllib.parse, urllib.request, random

MAILTO = "rnorlund@mailbox.sc.edu"
API_KEY = os.environ.get("OPENALEX_API_KEY", "").strip() or None
THROTTLE = 2.0

# Seed terms per field, plus the OpenAlex subfields we accept results from.
FIELDS = {
    "dental-oral": {
        "seeds": ["dental", "dentistry", "oral health", "periodontal", "endodontic",
                  "orthodontic", "caries", "tooth", "teeth", "maxillofacial",
                  "cone beam computed tomography", "oral microbiome", "dental implant",
                  "prosthodontic", "oral cancer", "temporomandibular", "dental radiography",
                  "oral surgery", "gingival", "enamel", "root canal", "malocclusion"],
        "subfields": ["Dentistry", "Oral Surgery", "Periodontics", "Orthodontics",
                      "Dental Assisting", "Dental Hygiene", "Otorhinolaryngology",
                      "Radiology, Nuclear Medicine and Imaging", "Oncology",
                      "Microbiology", "Surgery", "Public Health, Environmental and Occupational Health"],
    },
    "cardiovascular": {
        "seeds": ["cardiac", "cardiology", "cardiovascular", "heart failure", "myocardial",
                  "coronary artery", "atrial fibrillation", "echocardiography",
                  "cardiac magnetic resonance", "atherosclerosis", "hypertension",
                  "arrhythmia", "valvular heart disease", "congenital heart disease",
                  "cardiac computed tomography", "vascular imaging", "stroke prevention",
                  "aortic", "peripheral artery disease", "cardiac electrophysiology"],
        "subfields": ["Cardiology and Cardiovascular Medicine", "Radiology, Nuclear Medicine and Imaging",
                      "Internal Medicine", "Surgery", "Physiology", "Emergency Medicine",
                      "Epidemiology", "Critical Care and Intensive Care Medicine"],
    },
    "genetics": {
        "seeds": ["genome wide association", "genetics", "genomics", "gene expression",
                  "whole exome sequencing", "single cell RNA sequencing", "CRISPR",
                  "epigenetics", "DNA methylation", "transcriptomics", "polygenic risk score",
                  "rare disease variant", "population genetics", "heritability",
                  "gene therapy", "molecular genetics", "cancer genomics", "pharmacogenomics",
                  "mendelian randomization", "chromatin", "non coding RNA", "proteomics"],
        "subfields": ["Genetics", "Molecular Biology", "Genetics (clinical)", "Cancer Research",
                      "Bioinformatics", "Cell Biology", "Biochemistry", "Epidemiology",
                      "Computational Theory and Mathematics", "Molecular Medicine"],
    },
}

_last = [0.0]

def fetch(url, tries=6):
    delay = 2.0
    for attempt in range(tries):
        gap = time.time() - _last[0]
        if gap < THROTTLE:
            time.sleep(THROTTLE - gap + random.uniform(0, .3))
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "journalPicker/1.0 (mailto:%s)" % MAILTO})
            with urllib.request.urlopen(req, timeout=45) as r:
                _last[0] = time.time()
                return json.load(r)
        except urllib.error.HTTPError as e:
            _last[0] = time.time()
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                ra = e.headers.get("Retry-After")
                wait = float(ra) if ra and ra.isdigit() else delay
                print("    HTTP %d, waiting %.0fs" % (e.code, wait), flush=True)
                time.sleep(wait); delay = min(delay * 2, 60)
                continue
            raise
        except Exception:
            if attempt < tries - 1:
                time.sleep(delay); delay = min(delay * 2, 60); continue
            raise


def main():
    fid = sys.argv[1] if len(sys.argv) > 1 else None
    if fid not in FIELDS:
        raise SystemExit("usage: discover-topics.py {%s}" % "|".join(FIELDS))
    spec = FIELDS[fid]
    ok_subfields = {s.lower() for s in spec["subfields"]}

    found = {}
    for i, seed in enumerate(spec["seeds"], 1):
        url = ("https://api.openalex.org/topics?filter=display_name.search:%s"
               "&per-page=50&mailto=%s" % (urllib.parse.quote(seed), MAILTO))
        if API_KEY:
            url += "&api_key=" + urllib.parse.quote(API_KEY)
        try:
            data = fetch(url)
        except Exception as err:
            print("  [%2d/%2d] %-34s FAILED %s" % (i, len(spec["seeds"]), seed, err))
            continue
        hits = 0
        for t in data.get("results", []):
            sub = ((t.get("subfield") or {}).get("display_name") or "")
            if sub.lower() not in ok_subfields:
                continue
            tid = (t.get("id") or "").rsplit("/", 1)[-1]
            if not tid.startswith("T"):
                continue
            if tid not in found:
                found[tid] = {
                    "id": tid,
                    "display_name": t.get("display_name"),
                    "subfield": sub,
                    "field": ((t.get("field") or {}).get("display_name")),
                    "works_count": t.get("works_count"),
                    "keywords": (t.get("keywords") or [])[:6],
                    "via": seed,
                }
                hits += 1
        print("  [%2d/%2d] %-34s +%d new (%d total)"
              % (i, len(spec["seeds"]), seed, hits, len(found)), flush=True)

    topics = sorted(found.values(), key=lambda t: -(t["works_count"] or 0))
    outdir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "data", "fields")
    os.makedirs(outdir, exist_ok=True)
    out = os.path.join(outdir, "%s.topics.json" % fid)
    with open(out, "w") as fh:
        json.dump(topics, fh, indent=1)
    print("\n%d topics -> %s\n" % (len(topics), out))
    for t in topics[:45]:
        print("  %-9s %-56s %-38s %8d" % (t["id"], t["display_name"][:56],
                                          t["subfield"][:38], t["works_count"] or 0))


if __name__ == "__main__":
    main()
