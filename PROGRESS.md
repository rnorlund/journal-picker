# Journal Picker — status board

Ask **"progress"** any time and this gets refreshed.

**Last updated:** 2026-08-23
**Prototype:** working and testable locally · `python3 -m http.server 8899`
**Blocking decision:** OpenAlex API key (see Q1 in Open Questions)

---

## Legend
✅ done & verified · 🟡 in progress · ⬜ not started · 🔴 blocked · ⚪ deliberately not doing

---

## 1. Core application

| # | Item | Status | Notes |
|---|---|---|---|
| 1.1 | Multi-probe retrieval engine | ✅ | 8 probes, ~600 papers / ~260 venues per query, ~3 s |
| 1.2 | Journal scoring (similarity + topic volume + breadth) | ✅ | Verified: NeuroImage ranks #1 on an fMRI-methods abstract |
| 1.3 | "Similar papers they published" evidence | ✅ | Ranked by cross-probe agreement, not single-probe relevance |
| 1.4 | DOAJ-verified APC prices | ✅ | Corrects real OpenAlex errors; price source labelled on every card |
| 1.5 | Four publishing routes (any / OA / free / free+OA) | ✅ | "Free" ≠ "open access" modelled properly |
| 1.6 | Cost ceiling slider | ✅ | Over-budget journals greyed, not hidden |
| 1.7 | Quality filters (DOAJ, core venue, citedness, hide preprints) | ✅ | |
| 1.8 | Institutional agreement upload | ✅ | 8,588 journals from `uscoo.xlsm` in ~130 ms, zero deps |
| 1.9 | Rate limiting + backoff + credit metering | ✅ | Live credit balance in top bar; honest lockout message |
| 1.10 | API key support (per-user, localStorage) | ✅ | |
| 1.11 | Light/dark theme, responsive | ✅ | |
| 1.12 | Test suite | ✅ | 125 agreement assertions + 4 engine/UI suites, all passing |

## 2. Getting it in front of people

| # | Item | Status | Notes |
|---|---|---|---|
| 2.1 | Deployed public URL for testing | 🟡 | Netlify; `netlify-cli` already installed |
| 2.2 | Git repo initialised | 🟡 | Not yet a git repo |
| 2.3 | Public GitHub repo + licence + contributing | ⬜ | Needs repo name + licence choice (Q3) |
| 2.4 | Landing copy explaining what it does / doesn't do | ⬜ | |
| 2.5 | Shared-key backend proxy (optional) | ⬜ | Only needed if we don't want per-user keys (Q1) |

## 3. Precomputed catalog (optimisation, not a blocker)

| # | Item | Status | Notes |
|---|---|---|---|
| 3.1 | Curated brain-imaging topic set | ✅ | 78 topics, `data/topics.json` |
| 3.2 | Builder: throttled, checkpointed, resumable, shardable | ✅ | `SHARD=2/3`, `--merge-shards` |
| 3.3 | Topic-volume sweep across 78 topics | 🟡 | Sharded 3× on axon-server01/02/03 |
| 3.4 | Journal metadata enrichment | 🟡 | Running on server01 |
| 3.5 | DOAJ APC sweep for full catalog | 🟡 | Running on server01 |
| 3.6 | Merge shards → `data/journals.json` | ⬜ | After 3.3 completes on all three |
| 3.7 | Wire catalog into app (cheaper searches, offline browse) | ⬜ | |

## 4. Field expansion

Priority order as requested. Each field needs a lexicon pair (methods + populations)
and a curated topic set. The engine itself does not change.

| # | Field | Status | Notes |
|---|---|---|---|
| 4.1 | Brain imaging | ✅ | Shipped; lexicons live in `src/engine.js` |
| 4.2 | Refactor lexicons → per-field data files + auto-detect | ⬜ | Prerequisite for everything below |
| 4.3 | Aphasia / stroke | 🟡 | Largely covered by brain-imaging lexicons already; needs its own topic set to stand alone |
| 4.4 | Dental imaging / tooth & oral health | ⬜ | |
| 4.5 | Cardiovascular | ⬜ | |
| 4.6 | Genetics | ⬜ | |
| 4.7 | Further fields | ⬜ | ~3–4 weeks each, almost entirely data curation |

## 5. Known gaps

| # | Item | Status | Notes |
|---|---|---|---|
| 5.1 | Acceptance rates | 🔴 | **No open dataset exists.** Hardest gap. See Q4 |
| 5.2 | Time-to-first-decision / review speed | 🔴 | Same problem |
| 5.3 | Aims & scope text per journal | ⬜ | Needs scraping ~500 journal pages; 1–2 weeks |
| 5.4 | Embedding-based semantic matching | ⬜ | Would improve quality and cut credit cost; 3× L40S available |
| 5.5 | Predatory-journal screening | ⬜ | Cabell's is licensed; use DOAJ + Scopus + PubMed indexing as proxy |
| 5.6 | Institution presets (pick your university) | ⬜ | Needs a corpus of agreement lists; ongoing maintenance |
| 5.7 | Fabricated metrics | ⚪ | Deliberately excluded — no invented acceptance rates or fit scores |

---

## Open questions for Rob

1. **OpenAlex API key** — do you have one, or want me to set it up? Sharding across the three
   axon boxes works now, but a key is the durable fix and the only thing that makes a public
   site usable by strangers.
2. **Deploy target** — Netlify (fastest, `netlify-cli` is installed), or a campus/ASPH host?
3. **Repo name + licence** — `journal-picker`? MIT?
4. **Acceptance-rate data** — do you have institutional access to Journal Citation Reports or
   Cabell's? That's the only realistic route to 5.1/5.2 short of hand-curation.

## Infrastructure

| Host | Role | Specs |
|---|---|---|
| axon-server01 | catalog shard 1/3 + enrichment | 32 core, L40S 46 GB, 251 GB RAM |
| axon-server02 | catalog shard 2/3 | 32 core, L40S 46 GB |
| axon-server03 | catalog shard 3/3 | 32 core, L40S 46 GB |

Launch: `cd ~/journalPicker && SHARD=i/3 python3 -u scripts/build-catalog.py`
Logs: `~/journalPicker/build-shard<i>.log`
