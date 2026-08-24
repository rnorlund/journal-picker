#!/usr/bin/env python3
"""Derive each field's OpenAlex topic set from the cached taxonomy. No API calls.

A topic joins a field if its subfield is one the field claims, OR its name /
keywords / description match the field's patterns. Subfield alone is too
coarse (oral cancer lives under Oncology) and name matching alone is too noisy,
so we use both and print the result for review.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAX = os.path.join(ROOT, "data", "openalex-topics.json")

# subfields claimed outright, plus regexes that pull in cross-cutting topics
RULES = {
 "dental-oral": {
   "subfields": ["General Dentistry", "Oral Surgery", "Orthodontics", "Periodontics",
                 "Dental Hygiene", "Dental Assisting"],
   "patterns": [r"\bdent(al|istry|ine)\b", r"\btooth\b", r"\bteeth\b", r"\boral\b",
                r"periodont", r"orthodont", r"endodont", r"prosthodont", r"\bcaries\b",
                r"maxillofacial", r"craniofacial", r"temporomandibular", r"\benamel\b",
                r"\bsaliva", r"\bmandib", r"\bmaxilla", r"head and neck (cancer|carcinoma|squamous)"],
   "exclude": [r"oral (administration|delivery|drug|bioavailab|insulin|vaccine|contracept)",
               r"oral history", r"orality", r"oral tradition"],
 },
 "cardiovascular": {
   "subfields": ["Cardiology and Cardiovascular Medicine"],
   "patterns": [r"\bcardiac\b", r"\bcardio", r"\bheart\b", r"myocard", r"coronary",
                r"\baorti|\baorta", r"\batrial\b", r"ventricul", r"heart valv", r"arrhythmi",
                r"atheroscler", r"cardiovascular", r"\bartery\b|\barterial\b",
                r"\bvenous\b", r"hypertens", r"echocardiograph", r"thrombo",
                r"\bstent", r"cholesterol", r"electrocardio"],
   "exclude": [r"\bplant|\bflora|\bfauna|botan|\bfungi|mycorrhiz|\bcrop\b",
               r"insect|lepidopter|entomolog",
               # "ventricular" and "arterial" also describe the brain and the eye
               r"neurolog|\bbrain\b|cerebr|hydrocephal|\bglaucoma|retinal|\bocular",
               r"\bdental|\boral\b"],
 },
 "genetics": {
   "subfields": ["Genetics", "Molecular Biology", "Genetics (clinical)", "Bioinformatics",
                 "Computational Biology", "Cancer Research"],
   "patterns": [r"\bgene\b|\bgenes\b", r"\bgenom", r"\bgenetic", r"transcriptom",
                r"\bepigen", r"methylation", r"\bcrispr", r"\bvariant", r"mutation",
                r"chromosom", r"\ballel", r"\bexome\b", r"proteom", r"heritab",
                r"gene expression", r"polygenic", r"gene therapy", r"\bomics\b"],
   "exclude": [r"\bplant|\bflora|\bfauna|botan|mycorrhiz|\bcrop\b|wheat|barley|maize|rice",
               r"insect|lepidopter|entomolog|\bmoth\b|\bbeetle",
               r"livestock|cattle|poultry|aquacultur|fisher|forest|\bsoil\b",
               r"taxonom|biodiversity|paleontolog|\bfossil",
               # generic research-practice topics that match almost anything
               r"^medical and health sciences research$|^research (methods|ethics)"],
 },
}

def main():
    tax = json.load(open(TAX))["topics"]
    print("taxonomy: %d topics\n" % len(tax))
    for fid, rule in RULES.items():
        subs = {s.lower() for s in rule["subfields"]}
        pats = [re.compile(p, re.I) for p in rule["patterns"]]
        excl = [re.compile(p, re.I) for p in rule["exclude"]]
        picked = []
        for t in tax:
            name = t.get("display_name") or ""
            kw = " ".join(t.get("keywords") or [])
            desc = t.get("description") or ""
            # Match on name and keywords only. Descriptions are long and prose-y,
            # which is how "flora and fauna" ended up matching a vascular pattern
            # and Lepidoptera taxonomy ended up in genetics.
            hay = name + " || " + kw
            by_sub = (t.get("subfield") or "").lower() in subs
            by_pat = any(p.search(hay) for p in pats)
            if not (by_sub or by_pat):
                continue
            if any(p.search(hay + " || " + desc) for p in excl):
                continue
            # A pattern-only hit must be clinical. Subfield hits are trusted, so
            # model-organism topics still arrive via the Genetics subfield rather
            # than by sweeping in all of botany and entomology.
            if not by_sub and t.get("domain") != "Health Sciences":
                continue
            picked.append(t)
        picked.sort(key=lambda t: -(t["works_count"] or 0))

        path = os.path.join(ROOT, "data", "fields", "%s.json" % fid)
        with open(path) as fh:
            field = json.load(fh)
        field["topics"] = [t["id"] for t in picked]
        with open(path, "w") as fh:
            json.dump(field, fh, indent=1)

        # a reviewable companion file with names, not just ids
        with open(os.path.join(ROOT, "data", "fields", "%s.topics.json" % fid), "w") as fh:
            json.dump(picked, fh, indent=1)

        print("%-16s %4d topics  (%d by subfield)" % (
            fid, len(picked),
            sum(1 for t in picked if (t.get("subfield") or "").lower() in subs)))
        for t in picked[:8]:
            print("      %-8s %-52s %s" % (t["id"], (t["display_name"] or "")[:52],
                                           (t.get("subfield") or "")[:26]))
        print()

if __name__ == "__main__":
    main()
