# Journal Picker

Paste a manuscript title and abstract; get a ranked list of journals that actually publish
work like yours, with real prices, open-access status, and whether your institution has
already paid for it.

Built for brain-imaging manuscripts first. Nothing in the architecture is neuroimaging-specific
except two keyword lexicons, so widening it to another field is a data change, not a rewrite.

## Running it

It is a static site with no build step and no backend.

```bash
cd /Users/super/Documents/journalPicker
python3 -m http.server 8899
# open http://localhost:8899
```

Deploy by copying the directory to any static host (Netlify, GitHub Pages, S3, a campus web
server). There is no build step and no server-side component — but read the API key section
below before you put it in front of other people.

**Before deploying, set your contact address** in [src/engine.js](src/engine.js) —
`config.mailto`. OpenAlex uses it to put you in their faster "polite pool".

### You will need an OpenAlex API key

This is the single biggest operational constraint, and it bit us during development.

OpenAlex is now **credit-metered**, not just rate-limited. Every response carries
`x-ratelimit-*` headers, and a *search* query costs **10 credits**. This app spends about
**80 credits per manuscript** (8 relevance probes, plus cheap list queries for topic volume
and journal metadata).

Anonymous use is metered tightly — we exhausted it during testing and got
`retry-after: 1367`, a ~23 minute lockout. That is fine for a demo and useless for a shared
tool. A key raises the allowance by orders of magnitude.

The app therefore asks each user for **their own key**, stored in `localStorage` and sent only
to OpenAlex. A static site cannot hold a shared secret, and per-user keys mean per-user
allowances. The header-derived credit balance is shown in the top bar, and running out
produces an explicit message with the reset time — never a silent hang or a half-empty
result list.

If you want a single shared key instead, you need a small backend proxy that holds the key and
caches responses. That is the main reason to add a server; nothing else here needs one.

Cost control levers, in order of effect:

| lever | effect |
|---|---|
| `config.maxProbes` (default 8) | each probe removed saves ~10 credits/search |
| cache repeat queries client-side | identical abstracts cost nothing |
| precompute journal metadata + topic volumes offline | saves a few credits/search |

DOAJ, which supplies the APC prices, has no key requirement and no comparable metering.

## How the recommendation works

### 1. Multi-probe retrieval

OpenAlex's `search` ANDs every term, so one long query built from a whole abstract returns
almost nothing (a real 24-term query returned 20 papers). Instead the engine builds up to
eight short probes, each aimed at a different facet of the manuscript:

| probe | what it asks |
|---|---|
| `core` | the strongest content terms overall |
| `title-phrase` | the manuscript's own framing |
| `method`, `method-2` | the imaging modality, detected from a lexicon |
| `population`, `population-2` | the clinical population or cognitive domain |
| `broad` | high-recall backstop, down-weighted |
| `phrase-2` | second recurring phrase |

Their union examines ~600 similar papers across ~260 venues per query, in about 3 seconds.

### 2. Two independent signals

- **Similarity** — rank-decayed, recency-weighted counts of matching papers per journal.
  Answers "has this journal published papers like mine?"
- **Topic volume** — a `group_by` aggregation over the dominant OpenAlex topics.
  Answers "does this journal publish this *at volume*, or was that one paper a fluke?"

Plus a **breadth bonus** for journals matching several different probes, which favours venues
that fit the whole manuscript over ones that match a single keyword.

```
fit = 0.55 × similarity + 0.30 × log(topic volume) + 0.15 × breadth
```

### 3. Honest cost modelling

This is where most tools mislead people. "Free" and "open access" are different axes:

| route | you pay | readers pay |
|---|---|---|
| Subscription | nothing | paywall |
| Hybrid (paywalled option) | nothing | paywall |
| Hybrid (OA option) | APC | nothing |
| Gold OA | APC | nothing |
| Diamond OA | nothing | nothing |
| Covered by your agreement | nothing | nothing |

So the four publishing routes in the UI are genuinely different questions, and
"free **and** open access" is a much smaller set than either alone.

**APC prices come from DOAJ, not OpenAlex.** OpenAlex reports `apc_usd: null` both for
journals that charge nothing and for journals whose price nobody recorded — the two cases that
matter most here are indistinguishable. DOAJ records an explicit `has_apc` boolean, so the
engine cross-checks every journal with an ISSN against the DOAJ API and labels the price with
its source. This corrects real errors: OpenAlex lists Frontiers in Neurology at $3,801 where
DOAJ has CHF 3,150 (~$3,528), and Aperture Neuro looks free in OpenAlex but actually charges
$1,000.

Where the price genuinely cannot be verified, the journal is labelled
*"open access, price not published"* and treated as **not** affordable under a spending cap —
never silently as free.

### 4. Institutional agreements

Upload your library's read-and-publish list (`.xlsx`, `.xlsm`, `.csv`, `.tsv`). Matching
journals are flagged as already paid for and can be filtered to exclusively.

[src/agreements.js](src/agreements.js) parses real-world library spreadsheets with no
dependencies — it walks the ZIP central directory and inflates entries with the browser's
native `DecompressionStream`, so there is no SheetJS payload. It auto-detects the header row
and title/ISSN columns per sheet, treats each sheet as a publisher, validates ISSN checksums,
and merges multiple files.

Verified against USC's 16-sheet workbook: **8,588 journals, 8,113 with a valid ISSN, ~130 ms.**
Everything happens in the browser; the file is never uploaded anywhere.

## Tests

```bash
node test/test-agreements.mjs   # 125 assertions against the real workbook
node test/test-engine.mjs       # live retrieval quality on two abstracts
node test/test-samples.mjs      # checks the "similar papers" are actually similar
python3 test/ui-test.py         # drives the real page in Chromium
python3 test/ui-agreement.py    # end-to-end agreement upload
```

The UI tests need the local server running and Playwright's Chromium.

## Data files

- [data/topics.json](data/topics.json) — 78 curated OpenAlex topic IDs covering brain imaging
  (fMRI, structural MRI, diffusion, EEG/MEG, PET, lesion-symptom mapping, imaging in stroke /
  dementia / psychiatry, methods and software). Used to widen topic detection beyond whatever
  a single abstract happens to surface.
- [scripts/build-catalog.py](scripts/build-catalog.py) — resumable builder for a precomputed
  journal catalog (`data/journals.json`). **Unfinished**: it completed topic selection but only
  2 of 78 topic-volume batches before we stopped it, because it was consuming the same OpenAlex
  credit pool the app needs. Finish this with an API key. The app does not require it — the live
  engine works without a catalog — but it would cut per-search credit cost and enable an offline
  "browse all free neuroimaging journals" mode.

## Files

| file | role |
|---|---|
| [index.html](index.html) | markup and the result-card template |
| [src/engine.js](src/engine.js) | retrieval, scoring, OpenAlex + DOAJ access, rate limiting |
| [src/app.js](src/app.js) | cost model, filtering, rendering |
| [src/agreements.js](src/agreements.js) | dependency-free XLSX/CSV agreement parser |
| [src/style.css](src/style.css) | styles, light and dark |

## Known limitations

- **APCs are list prices.** Waivers, society discounts, membership rates, and page/colour
  charges are not modelled. Confirm with the publisher before submitting.
- **Agreement coverage is a claim about the journal, not about you.** Most read-and-publish
  deals require you to be the corresponding author, and many have annual caps.
- **No acceptance rates or review times.** No open dataset covers these reliably; anything
  shown would be invented. This is the single biggest gap versus what authors actually want.
- **Recommendations reflect what a journal published, not what it will accept.** High fit for
  *Nature Neuroscience* means your topic is in scope, not that it will be accepted.
- **English-language bias**, inherited from the index.
- Preprint servers and repositories are detected and hidden by default rather than silently
  dropped, since the classification is heuristic.
- **Journal name text comes from OpenAlex**, which strips apostrophes ("Alzheimer s &
  Dementia"). Common cases are repaired for display only.

## Extending beyond neuroimaging

Two lexicons in [src/engine.js](src/engine.js) — `MODALITY_LEXICON` (methods) and
`POPULATION_LEXICON` (populations/domains) — are the only field-specific code. Add the
equivalent method and population vocabulary for a new field and the rest carries over
unchanged, because topic detection comes from OpenAlex rather than from anything hardcoded.
