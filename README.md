# Journal Picker

Paste your title and abstract. Get a ranked list of journals that actually publish work like
yours — with real prices, open-access status, how long peer review takes, and whether your
institution has already paid for it.

**Live: https://journal-picker.netlify.app** — no sign-up, no API key, nothing to install.

```
Cortical thickness and white matter integrity predict naming recovery after stroke
→ 82%  Brain Communications        $4,024   ~222d review   you cite this journal 1×
  79%  NeuroImage: Clinical        $3,490   ~117d review   you cite this journal 1×
  74%  Frontiers in Neurology      $3,801    ~80d review
  66%  Brain and Language          $3,170   ~180d review   you cite this journal 2×
```

## Why this exists

Publisher-owned journal finders only show you that publisher's journals. Elsevier's finder will
never recommend a Wiley title. Tools built on abstract similarity alone can tell you a journal
publishes similar work but not what it will cost you, how long you will wait, or whether your
library already covers the fee.

This answers the questions authors actually ask:

- **Where does this belong?** Similar papers, journal specialisation, and — if you paste your
  reference list — the journals you already cite.
- **What will it cost me?** DOAJ-verified article processing charges, and an honest distinction
  between *free* and *open access*, which are not the same thing.
- **How long will review take?** Median submission-to-acceptance in days, computed from
  publisher-deposited PubMed dates.
- **Is it already paid for?** Upload your library's open-access agreement list.

## What makes the ranking work

Four signals, and the weights shift when you supply a reference list:

| Signal | What it measures |
|---|---|
| **Similarity** | Rank-decayed matches across several boolean queries against Europe PMC |
| **Field volume** | How much the journal publishes in your field, precomputed per discipline |
| **Specialisation** | What *share* of its output is in your field — this is what keeps pay-to-publish megajournals off page one. Cureus publishes ~6,000 in-field neuroimaging papers, but they are 5% of its output; Brain Communications is 54% in-field. |
| **Citation affinity** | Which journals your reference list cites. Only you have this information, and no database can infer it from a title and abstract. |

**Reference-list matching is the strongest signal and almost nothing else uses it.** Editors
check whether a submission engages with what they have published, and reviewers are drawn from
the same venues. It is implemented as a gazetteer lookup against the journal catalog rather than
by parsing reference strings, so it works in any citation style with no network calls.

## Honest limits

Read this section before trusting a number.

- **Review times cover about half of journals.** The figures come from `received` → `accepted`
  dates that publishers deposit with PubMed. Elsevier and MDPI deposit them; many societies do
  not. Every figure ships with its sample size, and journals with fewer than 8 usable articles
  show nothing rather than a noisy median.
- **Some deposited dates are not review times.** A handful of venues report medians of a few
  days, because they publish commissioned content or record the revision date as submission.
  No external peer review of a research paper finishes in under three weeks, so anything faster
  is flagged as unreliable instead of printed.
- **APCs are list prices** and change often. Confirm on the publisher's site before submitting.
  Non-USD prices are converted with approximate rates; the original amount and currency are kept.
- **Agreement coverage depends entirely on the file you upload** and on your eligibility as
  corresponding author. It is not a guarantee your library will pay.
- **Retrieval is biomedical.** Europe PMC indexes biomedical literature well. Fields with heavy
  computer-science or social-science components are under-covered — the language-models field
  says so on screen, because ACL, EMNLP and arXiv are largely absent.
- **No acceptance rates.** They are not in any open dataset, and unlike review times there is no
  proxy hiding in the data. We would rather omit them than invent them.
- **Nothing here is fabricated.** Every number traces to OpenAlex, DOAJ, PubMed, or Europe PMC.

## Fields

Field-specific knowledge lives entirely in `data/fields/*.json` — a methods lexicon, a
populations lexicon, and a topic set. Adding a discipline is a data change, not a rewrite. The
field is auto-detected from your abstract, and a manuscript can match several: a cardiac-genetics
paper matches both, and their catalogs are merged.

Brain imaging · aging · cardiovascular · dental & oral · genetics · language models and human
language · oncology · public health · implementation science · digital health & clinical AI ·
rehabilitation & communication sciences · psychiatry & mental health · microbiome · nutrition ·
global & planetary health · health professions education

## Running it

A static site. No build step, no backend, no API key.

```bash
python3 -m http.server 8899   # then open http://localhost:8899
```

Deploy by copying the directory to any static host. Optionally set `config.email` in
[src/engine.js](src/engine.js) so Europe PMC can identify your traffic.

## Data sources

| Source | Used for | Metered? |
|---|---|---|
| [Europe PMC](https://europepmc.org) | Finding similar papers, at query time | No — free, keyless, CORS-open, 1,000 results per call |
| [OpenAlex](https://openalex.org) | Journal metadata and field volume, offline only | Yes, which is why it is not in the request path |
| [DOAJ](https://doaj.org) | APC prices and open-access status | No |
| [PubMed](https://pubmed.ncbi.nlm.nih.gov) | Peer-review durations, offline only | Rate-limited, not credit-metered |

Version 1 used OpenAlex for retrieval and locked anonymous visitors out after a handful of
searches. Europe PMC replaced it: unmetered, and it supports real boolean queries, so one call
returns 1,000 results where OpenAlex needed eight AND-only probes for 600.

## Rebuilding the data

The app ships precomputed catalogs. To regenerate them:

```bash
python3 scripts/dump-taxonomy.py               # OpenAlex topic taxonomy, once
python3 scripts/derive-field-topics.py         # per-field topic sets, no API calls
FIELD=oncology python3 scripts/build-catalog.py    # one field's catalog
python3 scripts/build-timing.py                # peer-review durations from PubMed
python3 scripts/slim-catalogs.py               # write the served files
```

Every stage is throttled, checkpointed and resumable. `SHARD=2/3` splits work across machines;
`scripts/build-queue.sh` runs several fields in sequence on one machine.

## Tests

```bash
node test/test-agreements.mjs   # 125 assertions against a real institutional spreadsheet
node test/test-fields.mjs       # field auto-detection, including cross-field abstracts
node test/test-citations.mjs    # reference-list matching, plus noise and overlap guards
python3 test/ui-test.py         # end-to-end in a real browser
python3 test/ui-browse.py       # browse mode and its filters
python3 test/ui-agreement.py    # agreement upload
python3 test/ui-citations.py    # reference list changes the ranking
```

## Layout

```
index.html            single page
src/engine.js         retrieval, field detection, scoring
src/citations.js      reference-list matching
src/catalog.js        per-field catalogs, merged
src/fields.js         field definitions and auto-detection
src/agreements.js     XLSX/CSV parser — no dependencies, native DecompressionStream
src/app.js            UI
data/fields/*.json    per-field lexicons and topic rules
data/catalogs/*.json  precomputed journal catalogs
scripts/              data builders
status/               status board (grid.html → progress.png)
```

`src/agreements.js` parses `.xlsx`/`.xlsm` with no third-party library: it reads the ZIP central
directory and inflates entries with the browser's own `DecompressionStream`. 8,588 journals from
a real 16-sheet university workbook in about 130 ms.

## Licence

MIT. See [LICENSE](LICENSE).

Not affiliated with any publisher. Built because choosing a journal should not require guessing.
