#!/usr/bin/env python3
"""Download the entire OpenAlex topic taxonomy once, to data/openalex-topics.json.

~4,500 topics over ~23 paged calls. Every field's topic set is then derived
locally by subfield/field name, so adding a discipline costs no API calls at
all -- far cheaper and more complete than per-seed searches, which missed most
of dentistry.
"""
import json, os, time, urllib.request, urllib.error, random

# Both OpenAlex and NCBI ask callers to identify themselves, and doing so
# gets you better rate limits. Set JOURNALPICKER_EMAIL to your own address.
MAILTO = os.environ.get("JOURNALPICKER_EMAIL", "").strip() or "journal-picker@example.org"
API_KEY = os.environ.get("OPENALEX_API_KEY", "").strip() or None
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "data", "openalex-topics.json")

def get(url, tries=6):
    delay = 2.0
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "journalPicker/1.0 (mailto:%s)" % MAILTO})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and a < tries - 1:
                ra = e.headers.get("Retry-After")
                wait = float(ra) if ra and ra.replace('.','',1).isdigit() else delay
                print("    HTTP %d, waiting %.0fs" % (e.code, wait), flush=True)
                time.sleep(wait); delay = min(delay * 2, 60); continue
            raise
        except Exception:
            if a < tries - 1:
                time.sleep(delay); delay = min(delay * 2, 60); continue
            raise

def main():
    cursor, topics, page = "*", [], 0
    while cursor:
        url = ("https://api.openalex.org/topics?per-page=200&cursor=%s"
               "&select=id,display_name,description,keywords,subfield,field,domain,works_count"
               "&mailto=%s" % (urllib.parse.quote(cursor), MAILTO)) if False else (
              "https://api.openalex.org/topics?per-page=200&cursor=%s"
              "&select=id,display_name,description,keywords,subfield,field,domain,works_count"
              "&mailto=%s" % (cursor, MAILTO))
        if API_KEY:
            url += "&api_key=" + API_KEY
        d = get(url)
        batch = d.get("results", [])
        for t in batch:
            topics.append({
                "id": (t.get("id") or "").rsplit("/", 1)[-1],
                "display_name": t.get("display_name"),
                "description": t.get("description"),
                "keywords": t.get("keywords") or [],
                "subfield": (t.get("subfield") or {}).get("display_name"),
                "field": (t.get("field") or {}).get("display_name"),
                "domain": (t.get("domain") or {}).get("display_name"),
                "works_count": t.get("works_count"),
            })
        page += 1
        print("  page %2d  +%3d  total %d" % (page, len(batch), len(topics)), flush=True)
        cursor = (d.get("meta") or {}).get("next_cursor")
        if not batch:
            break
        time.sleep(1.2)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump({"count": len(topics), "topics": topics}, fh)
    print("\nwrote %s (%d topics, %d KB)" % (OUT, len(topics), os.path.getsize(OUT) // 1024))

    # what subfields exist, so field definitions can be written against reality
    from collections import Counter
    c = Counter(t["subfield"] or "?" for t in topics)
    print("\n%d distinct subfields. Dentistry-ish:" % len(c))
    for k, v in sorted(c.items()):
        if any(w in (k or "").lower() for w in
               ("dent", "oral", "periodon", "orthodon", "maxillo", "hygien")):
            print("   %4d  %s" % (v, k))

if __name__ == "__main__":
    import urllib.parse
    main()
