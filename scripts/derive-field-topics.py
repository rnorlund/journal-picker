#!/usr/bin/env python3
"""Derive each field's OpenAlex topic set from the cached taxonomy. No API calls.

A topic joins a field if its subfield is one the field claims, OR its name /
keywords / description match the field's patterns. Subfield alone is too
coarse (oral cancer lives under Oncology) and name matching alone is too noisy,
so we use both and print the result for review.
"""
import glob, json, os, re, sys

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
 "aging": {
   "subfields": ["Geriatrics and Gerontology", "Aging"],
   "gated_subfields": ["Neurology", "Cognitive Neuroscience", "Psychiatry and Mental health",
                       "Epidemiology", "Internal Medicine", "Public Health, Environmental and Occupational Health",
                       "Molecular Biology", "Cell Biology", "Endocrinology",
                       "Physiology", "Rehabilitation", "Nursing", "Health Policy",
                       "Experimental and Cognitive Psychology", "Radiology, Nuclear Medicine and Imaging",
                       "Genetics", "Immunology", "Nutrition and Dietetics", "Orthopedics and Sports Medicine"],
   # A bare "age" matches maternal age, gestational age and bone age, which
   # dragged in reproductive biology. Require the ageing sense explicitly.
   "patterns": [r"\bageing\b|\baging\b|age.related|age.associated", r"older adult|elderly|oldest old",
                r"geriatric|gerontolog", r"senescen", r"longevity|lifespan|healthspan",
                r"\bfrailty\b|sarcopenia", r"dementia|alzheimer", r"neurodegener",
                r"cognitive decline|cognitive ageing|cognitive aging",
                r"mild cognitive impairment", r"parkinson", r"telomere",
                r"\bfalls\b", r"osteoporosis", r"menopause",
                r"long term care|nursing home|palliative|end of life",
                r"macular degeneration", r"multimorbidit|polypharmac",
                r"life expectancy|mortality trends"],
   "exclude": [r"\bplant|\bcrop\b|agricultur|livestock|\bsoil\b|fisher",
               r"concrete|asphalt|material.{0,12}ag(e)?ing|corrosion|weathering",
               r"wine|cheese|food ag(e)?ing",
               r"archaeolog|radiocarbon|geochronolog|fossil",
               r"maternal age|gestational age|bone age|paternal age",
               r"reproductive biology|fertility"],
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
 # LLM x human language sits across AI, linguistics and cognitive science, so
 # loose name matching drags in history, archaeology and language pedagogy
 # ("corpus", "discourse"). Gate hard on subfield and name the anchors.
 "llm-language": {
   "subfields": ["Language and Linguistics", "Linguistics and Language"],
   "include_ids": ["T10181", "T10028", "T10403", "T10465", "T10201", "T12031",
                   "T10034", "T10383", "T13623"],
   "gated_subfields": ["Speech and Hearing", "Artificial Intelligence",
                       "Experimental and Cognitive Psychology",
                       "Cognitive Neuroscience", "Cognitive Psychology",
                       "Computer Science Applications", "Human-Computer Interaction",
                       "Computational Theory and Mathematics", "Developmental Neuroscience",
                       "Neurology", "Behavioral Neuroscience"],
   "patterns": [r"language model", r"natural language process", r"large language",
                r"computational lingu", r"psycholingu", r"neurolingu",
                r"machine translation", r"word embedding", r"distributional semantic",
                r"speech recognition", r"speech perception", r"phonetics|phonolog",
                r"\bsyntax\b|syntactic process", r"semantic process",
                r"language acquisition", r"language comprehension",
                r"language production", r"bilingual", r"sentence process",
                r"discourse process", r"reading comprehension", r"topic modeling",
                r"conversational agent|chatbot", r"transformer"],
   "exclude": [r"histor|archaeolog|ancient|medieval|classic|egypt|polish|literary",
               r"pedagog|curriculum|classroom|efl|esl|teaching|teacher|higher education",
               r"translation studies and practices", r"lexicograph",
               r"conservation|ecolog|landscape|geograph",
               r"political|sociolog|australian|spanish lingu",
               r"\bcrop\b|\bplant\b|agricultur",
               r"veterinar|nursing|school health|dental|dysphagia",
               r"noise effects|hearing loss and rehabilitation"],
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

def all_rules():
    """Built-in rules, plus any a field file carries in its own `topic_rules`.

    Keeping rules beside the lexicon they belong to means adding a discipline
    stays a single-file job.
    """
    rules = dict(RULES)
    for path in sorted(glob.glob(os.path.join(ROOT, "data", "fields", "*.json"))):
        base = os.path.basename(path)
        if base == "index.json" or base.endswith(".topics.json"):
            continue
        try:
            with open(path) as fh:
                spec = json.load(fh)
        except Exception:
            continue
        rule = spec.get("topic_rules")
        if rule:
            rules[spec.get("id") or base[:-5]] = rule
    return rules


def main():
    tax = json.load(open(TAX))["topics"]
    print("taxonomy: %d topics\n" % len(tax))
    for fid, rule in all_rules().items():
        subs = {s.lower() for s in rule.get("subfields", [])}
        # Broad subfields cannot be trusted wholesale. OpenAlex files
        # "Geochemistry and Geologic Mapping" under Artificial Intelligence, so
        # a topic from a gated subfield must also match one of the field's
        # patterns to count.
        gated = {s.lower() for s in rule.get("gated_subfields", [])}
        pats = [re.compile(p, re.I) for p in rule.get("patterns", [])]
        excl = [re.compile(p, re.I) for p in rule.get("exclude", [])]
        picked = []
        for t in tax:
            name = t.get("display_name") or ""
            kw = " ".join(t.get("keywords") or [])
            desc = t.get("description") or ""
            # Match on name and keywords only. Descriptions are long and prose-y,
            # which is how "flora and fauna" ended up matching a vascular pattern
            # and Lepidoptera taxonomy ended up in genetics.
            hay = name + " || " + kw
            sub = (t.get("subfield") or "").lower()
            by_pat = any(p.search(hay) for p in pats)
            by_sub = sub in subs or (sub in gated and by_pat)
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
        # Explicit anchors always count, whatever the subfield gating decides.
        must = set(rule.get("include_ids", []))
        if must:
            have = {t["id"] for t in picked}
            picked += [t for t in tax if t["id"] in must and t["id"] not in have]
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
