# Journal Picker — status board

Ask **"progress"** any time and this gets refreshed.

**Last updated:** 2026-08-23
**Live now:** https://journal-picker.netlify.app — no sign-up, no API key
**Local:** `python3 -m http.server 8899`
**No blockers.** The API-key problem is solved: retrieval moved off OpenAlex.

---

## Legend
✅ done & verified · 🟡 in progress · ⬜ not started · 🔴 blocked · ⚪ deliberately not doing

---

## 1. Core application

| # | Item | Status | Notes |
|---|---|---|---|
| 1.1 | Retrieval engine (Europe PMC, unmetered) | ✅ | Boolean queries, 1,000 results/call, ~2,000 papers / ~630 venues |
| 1.2 | Journal scoring (similarity + volume + breadth + specialisation) | ✅ | Verified on a stroke/aphasia abstract: Frontiers in Neurology, Brain Communications, NeuroImage: Clinical, Neurobiology of Language |
| 1.3 | "Similar papers they published" evidence | ✅ | Ranked by cross-query agreement, not one query's top hit |
| 1.4 | DOAJ-verified APC prices | ✅ | Precomputed into the catalog; source labelled on every card |
| 1.4b | Specialisation signal | ✅ | Share of a journal's output in your field — demotes megajournals (Cureus dropped off page 1) |
| 1.5 | Four publishing routes (any / OA / free / free+OA) | ✅ | "Free" ≠ "open access" modelled properly |
| 1.6 | Cost ceiling slider | ✅ | Over-budget journals greyed, not hidden |
| 1.7 | Quality filters (DOAJ, core venue, citedness, hide preprints) | ✅ | |
| 1.8 | Institutional agreement upload | ✅ | 8,588 journals from `uscoo.xlsm` in ~130 ms, zero deps |
| 1.9 | Rate limiting + backoff | ✅ | |
| 1.10 | API keys | ⚪ | No longer needed — nothing in the request path is metered |
| 1.11 | Light/dark theme, responsive | ✅ | |
| 1.12 | Test suite | ✅ | 125 agreement assertions + 4 engine/UI suites, all passing |

## 2. Getting it in front of people

| # | Item | Status | Notes |
|---|---|---|---|
| 2.1 | Deployed public URL for testing | ✅ | https://journal-picker.netlify.app |
| 2.2 | Git repo + MIT licence | ✅ | 2 commits |
| 2.3 | Push to public GitHub | ⬜ | Needs `gh repo create journal-picker --public` |
| 2.4 | Landing copy explaining what it does / doesn't do | ⬜ | |
| 2.5 | Backend proxy | ⚪ | Not needed — retrieval is unmetered |

## 3. Precomputed catalog (optimisation, not a blocker)

| # | Item | Status | Notes |
|---|---|---|---|
| 3.1 | Curated brain-imaging topic set | ✅ | 78 topics, `data/topics.json` |
| 3.2 | Builder: throttled, checkpointed, resumable, shardable | ✅ | `SHARD=2/3`, `--merge-shards` |
| 3.3 | Topic-volume sweep across 78 topics | ✅ | Sharded 3× across the build servers |
| 3.4 | Journal metadata enrichment | ✅ | 2,384 journals |
| 3.5 | DOAJ APC sweep | ✅ | 1,467 with a known APC, 632 in DOAJ |
| 3.6 | Merge shards → `data/journals.json` | ✅ | 3.4 MB (602 KB gzipped) |
| 3.7 | Catalog wired into app | ✅ | Now the sole source of journal metadata |
| 3.8 | Fix 2 journals whose DOAJ price didn't join | ⬜ | Imaging Neuroscience, Aperture Neuro show `gold` with no price |
| 3.9 | "Browse all free journals in my field" view | ⬜ | Catalog makes this trivial; 95 diamond venues to show |

## 4. Field expansion

Priority order as requested. Each field needs a lexicon pair (methods + populations)
and a curated topic set. The engine itself does not change.

| # | Field | Status | Notes |
|---|---|---|---|
| 4.1 | Brain imaging | ✅ | 72 methods, 50 populations, 78 topics in `data/fields/brain-imaging.json` |
| 4.2 | Refactor lexicons → per-field data files + auto-detect | ✅ | `src/fields.js` + `data/fields/`; adding a field is now a JSON drop-in |
| 4.3 | Aphasia / stroke | 🟡 | Already well covered by brain-imaging lexicons; own file only needed to widen non-imaging aphasia work |
| 4.4 | Dental imaging / tooth & oral health | ⬜ | |
| 4.5 | Cardiovascular | ⬜ | |
| 4.6 | Genetics | ⬜ | |
| 4.7 | Further fields | ⬜ | ~3–4 weeks each, almost entirely data curation |

## 5. Known gaps

| # | Item | Status | Notes |
|---|---|---|---|
| 5.1 | Acceptance rates | 🔴 | **No open dataset exists.** Hardest gap; checking USC's licensed access |
| 5.2 | Time-to-first-decision / review speed | 🔴 | Same problem |
| 5.3 | Aims & scope text per journal | ⬜ | Needs scraping ~500 journal pages; 1–2 weeks |
| 5.4 | Embedding-based semantic matching | ⬜ | Quality upgrade; 3× L40S idle and available |
| 5.8 | **Author ratings of journals** | ⬜ | Requested. Needs the project's first backend + moderation policy — see Ratings below |
| 5.5 | Predatory-journal screening | ⬜ | Cabell's is licensed; use DOAJ + Scopus + PubMed indexing as proxy |
| 5.6 | Institution presets (pick your university) | ⬜ | Needs a corpus of agreement lists; ongoing maintenance |
| 5.7 | Fabricated metrics | ⚪ | Deliberately excluded — no invented acceptance rates or fit scores |

---

## Author ratings — design sketch (item 5.8)

You're right that this doesn't exist anywhere and authors want it. It is also the first feature
that needs real infrastructure, and the first with legal exposure, so it needs deciding rather
than just building:

- **Storage** — Netlify Functions + a small database. No backend exists today.
- **Abuse** — ratings are public statements about named organisations. Without a moderation
  path, one angry author can post something defamatory about a real editor. Needs at minimum:
  rate limiting, no free-text about named individuals, a report/removal route, and a stated
  policy.
- **Sybil resistance** — the value depends on ratings being from real authors. Options:
  ORCID sign-in (best; proves publication record), institutional email, or open + heavily
  moderated.
- **Cold start** — an empty ratings page makes the tool look dead. Better to launch it for a
  specific community (OHMB, your department) than site-wide.
- **Suggested shape** — structured questions only (review speed, reviewer quality, editor
  responsiveness, would-submit-again) on fixed scales, plus optional short free text. Structured
  data is more useful, more comparable, and far less risky than open reviews.

My recommendation: ship everything else first, launch ratings with ORCID sign-in and structured
questions to a seeded community. Roughly 1–2 weeks once we commit.

## Answered

- **Retrieval backend** — moved off OpenAlex to Europe PMC. Unmetered, keyless, better queries.
  OpenAlex is still used, but only offline when building the catalog.
- **Next field** — refactor to multi-field first ✅ done. Dental, cardiovascular, genetics next.
- **Repo/licence** — `journal-picker`, MIT ✅ done.

## Still open for Rob

1. **Acceptance-rate data** — you asked me to check what USC has. Still to do; I'll report on
   JCR/Cabell's availability and licence terms before ingesting anything.
2. **Ratings** — the design decisions above, especially ORCID vs open.
3. **GitHub** — say the word and I'll push it public.

## Infrastructure

| Host | Role | Specs |
|---|---|---|
| build server 1 | catalog shard 1/3 + enrichment | 32 core, L40S 46 GB, 251 GB RAM |
| build server 2 | catalog shard 2/3 | 32 core, L40S 46 GB |
| build server 3 | catalog shard 3/3 | 32 core, L40S 46 GB |

Launch: `cd ~/journalPicker && SHARD=i/3 python3 -u scripts/build-catalog.py`
Logs: `~/journalPicker/build-shard<i>.log`
