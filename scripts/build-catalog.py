#!/usr/bin/env python3
"""
build-catalog.py -- Build a curated catalog of neuroimaging-relevant journals.

Sources of truth
  * OpenAlex  (https://api.openalex.org)  -- topics, publication volume, source metadata
  * DOAJ      (https://doaj.org/api)      -- authoritative APC / diamond-OA data

Outputs
  data/topics.json    the curated neuroimaging topic list
  data/journals.json  the journal catalog

Design notes
  * Every OpenAlex/DOAJ call is throttled to >= THROTTLE seconds apart and never
    run concurrently.  429/5xx are retried up to 6 times, honouring Retry-After
    (capped at MAX_BACKOFF) or backing off exponentially 2/4/8/16/30s.
  * Every expensive stage checkpoints into data/.cache/ and is skipped on rerun,
    so the build is fully resumable after a crash or a rate-limit wall.
  * Publication volume uses `primary_topic.id` rather than `topics.id`.  A work
    has exactly one primary topic, so per-topic counts can be summed across the
    topic set without double-counting works that carry several topics.  This
    guarantees neuro_works <= works_count and so neuro_share <= 1.
    (OpenAlex `group_by` returns at most 200 groups and does not page, so volume
    is collected one topic at a time to reach as far into the long tail as the
    API allows.)
  * No value in the output is invented.  Anything the APIs do not tell us is
    null, and `apc_known` / `oa_model` say so explicitly.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import random
from collections import defaultdict

# ---------------------------------------------------------------- configuration

MAILTO = "rnorlund@mailbox.sc.edu"
# OpenAlex is credit-metered; a search costs 10 credits and the anonymous
# allowance is small. Set OPENALEX_API_KEY to raise it substantially.
API_KEY = os.environ.get("OPENALEX_API_KEY", "").strip() or None

# Optional work sharding, e.g. SHARD="2/3" processes topics 2, 5, 8, ...
# Each shard checkpoints to its own cache file so shards never clobber one
# another; `--merge-shards` folds them back together.
def _parse_shard(spec):
    if not spec:
        return (1, 1)
    try:
        idx, cnt = (int(x) for x in spec.split("/", 1))
        if 1 <= idx <= cnt:
            return (idx, cnt)
    except Exception:
        pass
    raise SystemExit("SHARD must look like 2/3 (got %r)" % spec)


SHARD_INDEX, SHARD_COUNT = _parse_shard(os.environ.get("SHARD", "").strip())
VOLUME_CACHE = ("volume-progress.json" if SHARD_COUNT == 1
                else "volume-progress-%dof%d.json" % (SHARD_INDEX, SHARD_COUNT))
USER_AGENT = "journalPicker/1.0 (mailto:%s)" % MAILTO
THROTTLE = 2.0          # seconds between *any* two HTTP calls (shared IP)
MAX_BACKOFF = 30.0      # cap on a single backoff sleep
MAX_TRIES = 8

GENERATED = "2026-08-23"
FROM_DATE = "2020-01-01"
MIN_NEURO_WORKS = 20    # keep small specialist venues
TOPIC_BATCH = 50        # ids per /sources or /topics lookup
SOURCE_BATCH = 50
DOAJ_BATCH = 40
TOPICS_PER_JOURNAL = 12
SIZE_CAP_MB = 3.0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(DATA, ".cache")

# --------------------------------------------------------------- curated topics
# Hand-picked from the ~4,500 OpenAlex topics after enumerating every topic in
# the Neuroscience field and in the Radiology/Nuclear Medicine & Imaging,
# Neurology, Cognitive Neuroscience, Biological Psychiatry, Behavioral
# Neuroscience, Psychiatry & Mental Health, Neuropsychology, Speech & Hearing,
# Rehabilitation, Biomedical Engineering and Computer Vision subfields, plus
# ~60 targeted display_name searches.  Grouped by what they cover so the
# selection is auditable.  '*' marks the anchors named in the spec.

CURATED_TOPICS = {
    # -- imaging methods, modalities and analysis ---------------------------
    "T11304": "methods",   # * Advanced Neuroimaging Techniques and Applications
    "T10378": "methods",   # Advanced MRI Techniques and Applications
    "T10522": "methods",   # Medical Imaging Techniques and Applications (PET/CT)
    "T12422": "methods",   # Radiomics and Machine Learning in Medical Imaging
    "T11395": "methods",   # Radiopharmaceutical Chemistry and Applications
    "T10977": "methods",   # Optical Imaging and Spectroscopy (fNIRS / DOT)
    "T10052": "methods",   # Medical Image Segmentation Techniques
    "T11885": "methods",   # MRI in cancer diagnosis
    "T14510": "methods",   # Medical Imaging and Analysis (spine / CT+MRI DL)
    # -- fMRI, connectivity, cognitive neuroscience -------------------------
    "T10241": "function",  # * Functional Brain Connectivity Studies
    "T10581": "function",  # Neural dynamics and brain function
    "T10042": "function",  # Neural and Behavioral Psychology Studies
    "T10427": "function",  # Visual perception and processing mechanisms
    "T10448": "function",  # Memory and Neural Mechanisms
    "T10918": "function",  # Memory Processes and Influences
    "T10982": "function",  # Motor Control and Adaptation
    "T11094": "function",  # Face Recognition and Perception
    "T12621": "function",  # Hemispheric Asymmetry in Neuroscience
    "T10914": "function",  # Tactile and Sensory Interactions
    "T10788": "function",  # Neuroscience and Music Perception
    "T13219": "function",  # Mind wandering and attention
    "T12035": "function",  # Pain Management and Placebo Effect
    "T12520": "function",  # Psychology of Moral and Emotional Judgment
    "T13471": "function",  # Cognitive Functions and Memory
    # -- EEG / MEG / electrophysiology / BCI --------------------------------
    "T10429": "electro",   # * EEG and Brain-Computer Interfaces
    "T10985": "electro",   # Sleep and Wakefulness Research
    "T11601": "electro",   # Neuroscience and Neural Engineering
    # -- language, aphasia, lesion-symptom mapping --------------------------
    "T10465": "language",  # * Neurobiology of Language and Bilingualism
    "T10730": "language",  # Language Development and Disorders
    "T12608": "language",  # Spatial Neglect and Hemispheric Dysfunction
    "T10283": "language",  # Hearing Loss and Rehabilitation
    # -- TMS and neuromodulation -------------------------------------------
    "T10614": "stim",      # * Transcranial Magnetic Stimulation Studies
    "T10919": "stim",      # Neurological disorders and treatments (DBS)
    "T11921": "stim",      # Electroconvulsive Therapy Studies
    "T12580": "stim",      # Vagus Nerve Stimulation Research
    # -- dementia and neurodegeneration ------------------------------------
    "T10009": "degen",     # Dementia and Cognitive Impairment Research
    "T10085": "degen",     # Parkinson's Disease Mechanisms and Treatments
    "T14286": "degen",     # Parkinson's Disease and Spinal Disorders
    "T10949": "degen",     # Genetic Neurodegenerative Diseases
    "T11266": "degen",     # Neuroinflammation and Neurodegeneration Mechanisms
    "T10855": "degen",     # Amyotrophic Lateral Sclerosis Research
    "T14144": "degen",     # Neurological Disease Mechanisms (white matter lesions)
    "T13481": "degen",     # Neurological diseases and metabolism (brain iron)
    "T12331": "degen",     # Hereditary Neurological Disorders
    "T11406": "degen",     # Cerebrospinal fluid and hydrocephalus (glymphatic)
    # -- psychiatric neuroimaging ------------------------------------------
    "T10023": "psych",     # Schizophrenia research and treatment
    "T10537": "psych",     # Attention Deficit Hyperactivity Disorder
    "T10854": "psych",     # Bipolar Disorder and Treatment
    "T10106": "psych",     # Autism Spectrum Disorder Research
    "T13397": "psych",     # Hallucinations in medical conditions
    # -- stroke, vascular, trauma ------------------------------------------
    "T10227": "vascular",  # Acute Ischemic Stroke Management
    "T11763": "vascular",  # Intracerebral and Subarachnoid Hemorrhage Research
    "T10420": "vascular",  # Intracranial Aneurysms
    "T11929": "vascular",  # Cerebral Venous Sinus Thrombosis
    "T13648": "vascular",  # Cerebrovascular and genetic disorders
    "T11402": "vascular",  # Vascular Malformations Diagnosis and Treatment
    "T10706": "vascular",  # Traumatic Brain Injury and Neurovascular Disturbances
    "T10416": "vascular",  # Traumatic Brain Injury Research
    "T10510": "vascular",  # Stroke Rehabilitation and Recovery
    # -- epilepsy and other clinical neurology -----------------------------
    "T10094": "clinical",  # Epilepsy research and treatment
    "T10498": "clinical",  # Migraine and Headache Studies
    "T10137": "clinical",  # Multiple Sclerosis Research Studies
    "T11097": "clinical",  # Cerebral Palsy and Movement Disorders
    "T11627": "clinical",  # Autoimmune Neurological Disorders and Treatments
    "T12494": "clinical",  # Alcoholism and Thiamine Deficiency (Wernicke)
    "T10542": "clinical",  # Vestibular and auditory disorders
    # -- neuro-oncology imaging --------------------------------------------
    "T12702": "onco",      # Brain Tumor Detection and Classification
    "T10129": "onco",      # Glioma Diagnosis and Treatment
    "T11600": "onco",      # Brain Metastases and Treatment
    "T12212": "onco",      # CNS Lymphoma Diagnosis and Treatment
    "T11173": "onco",      # Neurofibromatosis and Schwannoma Cases
    # -- developmental / paediatric ----------------------------------------
    "T12552": "develop",   # Fetal and Pediatric Neurological Disorders
    "T11184": "develop",   # Neonatal and fetal brain pathology
    "T14104": "develop",   # Developmental and Educational Neuropsychology
    "T10608": "develop",   # Neurogenesis and neuroplasticity mechanisms
    # -- spinal cord and whole-CNS -----------------------------------------
    "T10925": "spinal",    # Spinal Cord Injury Research
    "T12622": "spinal",    # Neurosurgical Procedures and Complications
    # -- neuroethics / imaging in society ----------------------------------
    "T11953": "meta",      # Neuroethics, Human Enhancement (incidental findings)
}

# Venues that must be flagged as archives / preprint servers regardless of the
# `type` OpenAlex reports for them.
REPOSITORY_NAMES = (
    "zenodo", "figshare", "dans", "ssrn", "researchgate", "dataverse",
    "openneuro", "dryad", "osf", "hal ", "hal-", "repositório", "repository",
    "elsevier bv" ,
)
PREPRINT_NAMES = (
    "biorxiv", "medrxiv", "arxiv", "research square", "preprints.org",
    "preprint", "chemrxiv", "psyarxiv", "authorea", "techrxiv", "essoar",
)

REQUIRED_JOURNALS = [
    "NeuroImage", "NeuroImage: Clinical", "Human Brain Mapping",
    "Brain Structure and Function", "Cerebral Cortex", "Journal of Neuroscience",
    "Brain and Language", "Neurobiology of Language", "Imaging Neuroscience",
    "Aperture Neuro", "Frontiers in Neuroscience", "eNeuro",
    "Brain Communications", "Magnetic Resonance in Medicine", "Neuroinformatics",
    "Nature Neuroscience",
]

# ------------------------------------------------------------------ http layer

_last_call = [0.0]


def _throttle():
    gap = time.time() - _last_call[0]
    if gap < THROTTLE:
        # jitter so we do not sync up with whatever else shares this IP
        time.sleep(THROTTLE - gap + random.uniform(0, 0.4))


def fetch(url, label="", tries=MAX_TRIES):
    """Politely GET a URL and parse JSON.  Retries 429/5xx and transport errors."""
    delay = 2.0
    for attempt in range(tries):
        _throttle()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=45) as resp:
                payload = json.load(resp)
            _last_call[0] = time.time()
            return payload
        except urllib.error.HTTPError as err:
            _last_call[0] = time.time()
            if err.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                wait = delay
                retry_after = err.headers.get("Retry-After")
                if retry_after:
                    try:
                        wait = float(retry_after)
                    except ValueError:
                        pass
                # A long Retry-After means the credit budget is spent, not that
                # we are going too fast. Capping it just wastes every retry, so
                # wait it out -- the build is checkpointed and unattended.
                if retry_after and wait > MAX_BACKOFF:
                    log("    HTTP %d -- credit limit hit, sleeping %.0fs (%.1f min) for reset"
                        % (err.code, wait, wait / 60.0))
                else:
                    wait = min(wait, MAX_BACKOFF)
                    log("    HTTP %d on %s -- backing off %.0fs (try %d/%d)"
                        % (err.code, label or url[:60], wait, attempt + 1, tries))
                time.sleep(wait)
                delay = min(delay * 2, MAX_BACKOFF)
                continue
            raise
        except Exception as err:                      # transport / JSON errors
            _last_call[0] = time.time()
            if attempt < tries - 1:
                log("    %s on %s -- backing off %.0fs"
                    % (type(err).__name__, label or url[:60], delay))
                time.sleep(delay)
                delay = min(delay * 2, MAX_BACKOFF)
                continue
            raise


def openalex(path, label=""):
    sep = "&" if "?" in path else "?"
    url = "https://api.openalex.org/" + path + sep + "mailto=" + MAILTO
    if API_KEY:
        url += "&api_key=" + urllib.parse.quote(API_KEY)
    return fetch(url, label=label or path[:60])


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


# ------------------------------------------------------------------- cache i/o

def cache_path(name):
    return os.path.join(CACHE, name)


def load_json(name, default=None):
    path = cache_path(name)
    if os.path.exists(path):
        try:
            with open(path) as fh:
                return json.load(fh)
        except (ValueError, IOError):
            log("  ! cache %s unreadable, rebuilding" % name)
    return default


def save_json(name, obj):
    path = cache_path(name)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh)
    os.replace(tmp, path)


def load_jsonl(name):
    path = cache_path(name)
    rows = []
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass                              # torn final line
    return rows


def append_jsonl(name, rows):
    with open(cache_path(name), "a") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def bare(oid):
    return oid.rstrip("/").rsplit("/", 1)[-1] if oid else None


def chunks(seq, size):
    seq = list(seq)
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


# ------------------------------------------------------- step 1: topic details

def step1_topics():
    cached = load_json("topics.json")
    if cached and len(cached) == len(CURATED_TOPICS):
        log("STEP 1  %d curated topics (cached)" % len(cached))
        return cached

    log("STEP 1  resolving %d curated topics" % len(CURATED_TOPICS))
    want = list(CURATED_TOPICS)
    found = {}
    select = "id,display_name,description,keywords,subfield,field,domain,works_count"
    for batch in chunks(want, TOPIC_BATCH):
        path = ("topics?filter=openalex:%s&per-page=%d&select=%s"
                % ("|".join(batch), TOPIC_BATCH, select))
        data = openalex(path, label="topics batch")
        for row in data["results"]:
            found[bare(row["id"])] = row
        log("  resolved %d/%d" % (len(found), len(want)))

    missing = [t for t in want if t not in found]
    if missing:
        raise SystemExit("topic ids not found in OpenAlex: %s" % missing)

    topics = []
    for tid in want:
        row = found[tid]
        topics.append({
            "id": tid,
            "display_name": row["display_name"],
            "subfield": (row.get("subfield") or {}).get("display_name"),
            "field": (row.get("field") or {}).get("display_name"),
            "domain": (row.get("domain") or {}).get("display_name"),
            "group": CURATED_TOPICS[tid],
            "keywords": row.get("keywords") or [],
            "works_count": row.get("works_count"),
        })
    topics.sort(key=lambda t: -(t["works_count"] or 0))
    save_json("topics.json", topics)
    return topics


# ---------------------------------------------------- step 2: publication volume

def step2_volume(topics):
    """Per-source counts of 2020+ articles whose PRIMARY topic is in our set.

    One call per topic: `group_by` caps at 200 groups and cannot page, so the
    finest possible granularity reaches deepest into the long tail.  Each topic's
    result is checkpointed, so a rerun only fetches what is missing.
    """
    done = load_json(VOLUME_CACHE, default={}) or {}
    # Anything an earlier unsharded or merged run already fetched still counts.
    if SHARD_COUNT > 1:
        for tid, groups in (load_json("volume-progress.json", default={}) or {}).items():
            done.setdefault(tid, groups)
    counts = defaultdict(int)
    names = {}
    for tid, groups in done.items():
        for sid, cnt, nm in groups:
            counts[sid] += cnt
            names[sid] = nm

    mine = [t for i, t in enumerate(topics)
            if SHARD_COUNT == 1 or i % SHARD_COUNT == (SHARD_INDEX - 1)]
    if SHARD_COUNT > 1:
        log("  shard %d/%d owns %d of %d topics"
            % (SHARD_INDEX, SHARD_COUNT, len(mine), len(topics)))
    todo = [t["id"] for t in mine if t["id"] not in done]
    log("STEP 2  publication volume: %d topics cached, %d to fetch"
        % (len(done), len(todo)))

    # A shared IP can keep us behind a 429 wall for minutes.  Never abandon the
    # run: sweep the outstanding topics repeatedly, checkpointing each success,
    # until none are left.
    for sweep in range(1, 13):
        if not todo:
            break
        if sweep > 1:
            log("  sweep %d for %d topic(s) still outstanding" % (sweep, len(todo)))
        failed = []
        for i, tid in enumerate(todo, 1):
            path = ("works?filter=primary_topic.id:%s,from_publication_date:%s,"
                    "type:article&group_by=primary_location.source.id&per-page=200"
                    % (tid, FROM_DATE))
            try:
                data = openalex(path, label="volume " + tid)
            except Exception as err:
                log("  [%3d/%3d] %s FAILED (%s) -- will retry in next sweep"
                    % (i, len(todo), tid, type(err).__name__))
                failed.append(tid)
                time.sleep(5.0)
                continue
            groups = []
            for grp in data.get("group_by", []):
                sid = bare(grp.get("key"))
                if not sid or not sid.startswith("S"):
                    continue                          # 'unknown' bucket
                groups.append([sid, grp["count"], grp.get("key_display_name")])
                counts[sid] += grp["count"]
                names[sid] = grp.get("key_display_name")
            done[tid] = groups
            save_json(VOLUME_CACHE, done)             # checkpoint every topic
            log("  [%3d/%3d] %s  %d sources, %d distinct so far"
                % (i, len(todo), tid, len(groups), len(counts)))
        todo = failed
        if todo:
            time.sleep(30.0)
    if todo:
        raise SystemExit("volume stage could not fetch: %s (rerun to resume)" % todo)

    volume = {"counts": dict(counts), "names": names}
    save_json("volume-counts.json", volume)
    log("  %d distinct sources seen; %d at >= %d works"
        % (len(counts), sum(1 for v in counts.values() if v >= MIN_NEURO_WORKS),
           MIN_NEURO_WORKS))
    return volume


# ------------------------------------------------------- step 3: enrich sources

SOURCE_SELECT = ("id,display_name,alternate_titles,abbreviated_title,issn,issn_l,"
                 "is_oa,is_in_doaj,is_core,is_indexed_in_scopus,"
                 "is_preprint_repository,apc_usd,apc_prices,type,"
                 "host_organization_name,homepage_url,works_count,cited_by_count,"
                 "summary_stats,topics,counts_by_year")


def step3_sources(candidate_ids):
    have = {bare(r["id"]): r for r in load_jsonl("sources-raw.jsonl")}
    todo = [s for s in candidate_ids if s not in have]
    log("STEP 3  enriching sources: %d cached, %d to fetch"
        % (len(have), len(todo)))

    select = SOURCE_SELECT
    for i, batch in enumerate(chunks(todo, SOURCE_BATCH), 1):
        path = ("sources?filter=openalex:%s&select=%s&per-page=%d"
                % ("|".join(batch), select, SOURCE_BATCH))
        try:
            data = openalex(path, label="sources batch %d" % i)
        except urllib.error.HTTPError as err:  # noqa: PERF203
            if err.code == 400 and "is_core" in select:
                log("    /sources rejected a select field; retrying without is_core")
                select = select.replace("is_core,", "")
                path = ("sources?filter=openalex:%s&select=%s&per-page=%d"
                        % ("|".join(batch), select, SOURCE_BATCH))
                data = openalex(path, label="sources batch %d retry" % i)
            else:
                raise
        rows = data["results"]
        append_jsonl("sources-raw.jsonl", rows)       # checkpoint every batch
        for row in rows:
            have[bare(row["id"])] = row
        log("  [%d] +%d  total %d" % (i, len(rows), len(have)))
    return have


# ------------------------------------------------------------ step 3b: DOAJ APC

def doaj_lookup(issns):
    """DOAJ is the authoritative source for 'is publishing here free?'.

    OpenAlex reports apc_usd=null both for 'no APC' and for 'price not
    recorded', so it cannot distinguish diamond OA from unknown.  DOAJ records
    bibjson.apc.has_apc explicitly.
    """
    have = {}
    for row in load_jsonl("doaj.jsonl"):
        have[row["issn"]] = row
    todo = [i for i in issns if i not in have]
    log("STEP 3b DOAJ APC lookup: %d ISSNs cached, %d to query"
        % (len(have), len(todo)))

    for i, batch in enumerate(chunks(todo, DOAJ_BATCH), 1):
        query = "issn:(%s)" % " OR ".join(batch)
        url = ("https://doaj.org/api/search/journals/%s?pageSize=100"
               % urllib.parse.quote(query, safe=""))
        try:
            data = fetch(url, label="doaj batch %d" % i)
        except urllib.error.HTTPError as err:
            log("    DOAJ batch %d failed HTTP %d -- recording as not-found"
                % (i, err.code))
            data = {"results": []}

        # Map every ISSN a returned journal carries back onto our query batch.
        rows = []
        matched = set()
        for res in data.get("results", []):
            bj = res.get("bibjson") or {}
            apc = bj.get("apc") or {}
            prices = apc.get("max") or []
            price = prices[0].get("price") if prices else None
            currency = prices[0].get("currency") if prices else None
            journal_issns = set()
            for key in ("pissn", "eissn"):
                if bj.get(key):
                    journal_issns.add(bj[key].strip().upper())
            for ident in bj.get("identifier") or []:
                if ident.get("type") in ("pissn", "eissn") and ident.get("id"):
                    journal_issns.add(ident["id"].strip().upper())
            record = {
                "found": True,
                "doaj_title": bj.get("title"),
                "doaj_has_apc": apc.get("has_apc"),
                "doaj_apc_price": price,
                "doaj_apc_currency": currency,
                "doaj_apc_url": apc.get("url"),
                "doaj_issns": sorted(journal_issns),
            }
            for issn in journal_issns:
                if issn in batch:
                    matched.add(issn)
                    row = dict(record, issn=issn)
                    rows.append(row)
                    have[issn] = row
        for issn in batch:
            if issn not in matched:
                row = {"issn": issn, "found": False, "doaj_has_apc": None,
                       "doaj_apc_price": None, "doaj_apc_currency": None,
                       "doaj_apc_url": None}
                rows.append(row)
                have[issn] = row
        append_jsonl("doaj.jsonl", rows)              # checkpoint every batch
        log("  [%d] queried %d, matched %d in DOAJ" % (i, len(batch), len(matched)))
    return have


# ------------------------------------------------------ step 4: clean & classify

def classify_kind(row):
    name = (row.get("display_name") or "").lower()
    stype = (row.get("type") or "").lower()
    if row.get("is_preprint_repository"):
        return "preprint"
    if any(tok in name for tok in PREPRINT_NAMES):
        return "preprint"
    if stype == "repository" or any(tok in name for tok in REPOSITORY_NAMES):
        return "repository"
    if stype == "journal":
        return "journal"
    if stype == "conference":
        return "conference"
    if stype in ("book series", "ebook platform", "metadata", "other", ""):
        return "other"
    return "other"


def resolve_apc(row, doaj):
    """Return (apc_known, amount, currency, source) using DOAJ first."""
    if doaj and doaj.get("found"):
        has_apc = doaj.get("doaj_has_apc")
        if has_apc is False:
            return True, 0, None, "doaj"
        if has_apc is True and doaj.get("doaj_apc_price") is not None:
            return True, doaj["doaj_apc_price"], doaj.get("doaj_apc_currency"), "doaj"
        if has_apc is True:
            # DOAJ says a fee exists but records no figure; fall through to
            # OpenAlex for the number, otherwise 'known to charge, price unknown'.
            if row.get("apc_usd") is not None:
                return True, row["apc_usd"], "USD", "openalex"
            return True, None, None, "doaj"
    if row.get("apc_usd") is not None:
        return True, row["apc_usd"], "USD", "openalex"
    return False, None, None, None


def classify_oa(row, doaj, apc_known, apc_amount):
    """Five honest buckets; never guess diamond from a null price."""
    is_oa = bool(row.get("is_oa"))
    in_doaj_api = bool(doaj and doaj.get("found"))
    if in_doaj_api and doaj.get("doaj_has_apc") is False:
        return "diamond"              # confirmed OA *and* confirmed free to publish
    priced = apc_known and apc_amount is not None and apc_amount > 0
    if is_oa or row.get("is_in_doaj") or in_doaj_api:
        return "gold" if priced else "oa-apc-unknown"
    if priced:
        return "hybrid"
    return "subscription"


def build_records(sources, volume, doaj_by_issn, topics_per_journal,
                  keep_counts_by_year):
    counts = volume["counts"]
    out = []
    dropped = 0
    for sid, row in sources.items():
        name = (row.get("display_name") or "").strip()
        if not name:
            dropped += 1
            continue

        issns = [i.strip().upper() for i in (row.get("issn") or []) if i]
        doaj = None
        for issn in ([row.get("issn_l")] if row.get("issn_l") else []) + issns:
            hit = doaj_by_issn.get((issn or "").strip().upper())
            if hit and hit.get("found"):
                doaj = hit
                break
        if doaj is None:
            for issn in issns:
                if issn in doaj_by_issn:
                    doaj = doaj_by_issn[issn]
                    break

        apc_known, apc_amount, apc_currency, apc_source = resolve_apc(row, doaj)
        stats = row.get("summary_stats") or {}
        two_yr = stats.get("2yr_mean_citedness")
        works_count = row.get("works_count") or 0
        neuro_works = counts.get(sid, 0)

        topic_list = []
        for t in (row.get("topics") or [])[:topics_per_journal]:
            topic_list.append({"id": bare(t.get("id")),
                               "name": t.get("display_name"),
                               "count": t.get("count")})

        rec = {
            "id": sid,
            "display_name": name,
            "alternate_titles": row.get("alternate_titles") or [],
            "abbreviated_title": row.get("abbreviated_title"),
            "issn": issns,
            "issn_l": row.get("issn_l"),
            "type": row.get("type"),
            "kind": classify_kind(row),
            "publisher": row.get("host_organization_name"),
            "homepage_url": row.get("homepage_url"),
            "is_oa": row.get("is_oa"),
            "is_in_doaj": row.get("is_in_doaj"),
            "is_core": row.get("is_core"),
            "is_preprint_repository": row.get("is_preprint_repository"),
            "apc_usd": row.get("apc_usd"),
            "apc_prices": row.get("apc_prices") or [],
            "apc_known": apc_known,
            "apc_amount": apc_amount,
            "apc_currency": apc_currency,
            "apc_source": apc_source,
            "in_doaj_api": bool(doaj and doaj.get("found")),
            "doaj_has_apc": (doaj or {}).get("doaj_has_apc"),
            "doaj_apc_price": (doaj or {}).get("doaj_apc_price"),
            "doaj_apc_currency": (doaj or {}).get("doaj_apc_currency"),
            "doaj_apc_url": (doaj or {}).get("doaj_apc_url"),
            "works_count": works_count,
            "cited_by_count": row.get("cited_by_count"),
            "h_index": stats.get("h_index"),
            "i10_index": stats.get("i10_index"),
            "two_yr_mean_citedness": round(two_yr, 2) if two_yr is not None else None,
            "topics": topic_list,
            "neuro_works": neuro_works,
            "neuro_share": round(neuro_works / works_count, 3) if works_count else None,
        }
        rec["oa_model"] = classify_oa(row, doaj, apc_known, apc_amount)
        if keep_counts_by_year:
            rec["counts_by_year"] = [
                {"year": c["year"], "works_count": c["works_count"]}
                for c in (row.get("counts_by_year") or [])
            ]
        out.append(rec)
    out.sort(key=lambda r: (-r["neuro_works"], r["display_name"]))
    return out, dropped


# ------------------------------------------------------------------ validation

def validate(payload, path):
    journals = payload["journals"]
    log("")
    log("=" * 78)
    log("VALIDATION")
    log("=" * 78)
    log("total venues in catalog: %d" % len(journals))

    by_kind = defaultdict(int)
    by_oa = defaultdict(int)
    for j in journals:
        by_kind[j["kind"]] += 1
        by_oa[j["oa_model"]] += 1
    log("")
    log("by kind:")
    for k, n in sorted(by_kind.items(), key=lambda x: -x[1]):
        log("  %-12s %5d" % (k, n))
    log("")
    log("by oa_model:")
    for k, n in sorted(by_oa.items(), key=lambda x: -x[1]):
        log("  %-16s %5d" % (k, n))

    # required journals
    index = {}
    for j in journals:
        index.setdefault(j["display_name"].lower(), j)
        for alt in j["alternate_titles"]:
            index.setdefault(alt.lower(), j)
    log("")
    log("required journals:")
    log("  %-34s %-8s %-9s %-16s %s" % ("name", "neuro", "works", "oa_model", "apc"))
    missing = []
    for name in REQUIRED_JOURNALS:
        j = index.get(name.lower())
        if not j:
            missing.append(name)
            log("  %-34s MISSING" % name[:34])
            continue
        apc = "-" if j["apc_amount"] is None else ("%g %s" % (
            j["apc_amount"], j["apc_currency"] or "USD"))
        log("  %-34s %-8d %-9d %-16s %s"
            % (name[:34], j["neuro_works"], j["works_count"], j["oa_model"], apc))
        assert j["neuro_works"] >= MIN_NEURO_WORKS, name
        assert j["works_count"] > 0, name
        assert j["kind"] == "journal", "%s classified as %s" % (name, j["kind"])
    if missing:
        log("  !! MISSING: %s" % missing)

    # APC coverage
    known = [j for j in journals if j["apc_known"]]
    free = [j for j in journals if j["apc_amount"] == 0]
    in_doaj = [j for j in journals if j["in_doaj_api"]]
    log("")
    log("APC coverage:")
    log("  known APC status (DOAJ or OpenAlex): %d / %d" % (len(known), len(journals)))
    log("  APC-free (confirmed 0):              %d" % len(free))
    log("  found in the DOAJ API:               %d" % len(in_doaj))
    log("  is_in_doaj per OpenAlex:             %d"
        % sum(1 for j in journals if j["is_in_doaj"]))

    # diamond list
    diamond = [j for j in journals
               if j["oa_model"] == "diamond" and j["kind"] == "journal"]
    diamond.sort(key=lambda j: -j["neuro_works"])
    log("")
    log("diamond OA journals (in DOAJ, has_apc == false): %d" % len(diamond))
    for j in diamond[:60]:
        log("  %-6d %-52s %s" % (j["neuro_works"], j["display_name"][:52],
                                 (j["publisher"] or "")[:24]))
    if len(diamond) > 60:
        log("  ... and %d more" % (len(diamond) - 60))

    # top 25 table
    top = [j for j in journals if j["kind"] == "journal"][:25]
    log("")
    log("25 largest neuroimaging journals:")
    log("  %-4s %-44s %-8s %-8s %-16s %s"
        % ("#", "journal", "neuro", "share", "oa_model", "apc"))
    for i, j in enumerate(top, 1):
        apc = "-" if j["apc_amount"] is None else ("%g %s" % (
            j["apc_amount"], j["apc_currency"] or "USD"))
        log("  %-4d %-44s %-8d %-8s %-16s %s"
            % (i, j["display_name"][:44], j["neuro_works"],
               j["neuro_share"], j["oa_model"], apc))

    size = os.path.getsize(path)
    log("")
    log("journals.json: %.2f MB (%d bytes)" % (size / 1e6, size))
    return missing, size


# ------------------------------------------------------------------------ main

def merge_shards():
    """Fold every volume-progress-*of*.json back into volume-progress.json."""
    import glob
    merged = load_json("volume-progress.json", default={}) or {}
    files = sorted(glob.glob(os.path.join(CACHE, "volume-progress-*of*.json")))
    if not files:
        raise SystemExit("no shard files found in %s" % CACHE)
    for path in files:
        with open(path) as fh:
            part = json.load(fh)
        new = [t for t in part if t not in merged]
        merged.update(part)
        log("  %-42s %4d topics (%d new)"
            % (os.path.basename(path), len(part), len(new)))
    save_json("volume-progress.json", merged)
    log("merged -> volume-progress.json: %d topics total" % len(merged))
    return merged


def main():
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)

    if "--merge-shards" in sys.argv:
        merge_shards()
        if "--continue" not in sys.argv:
            return

    topics = step1_topics()
    with open(os.path.join(DATA, "topics.json"), "w") as fh:
        json.dump(topics, fh, indent=1)
    log("  wrote topics.json (%d topics, %d total works across them)"
        % (len(topics), sum(t["works_count"] or 0 for t in topics)))

    volume = step2_volume(topics)
    candidates = sorted(
        (sid for sid, n in volume["counts"].items() if n >= MIN_NEURO_WORKS),
        key=lambda s: -volume["counts"][s])
    log("  %d candidate sources at >= %d neuro works"
        % (len(candidates), MIN_NEURO_WORKS))

    sources = step3_sources(candidates)
    sources = {k: v for k, v in sources.items() if k in set(candidates)}

    issns = set()
    for row in sources.values():
        if row.get("issn_l"):
            issns.add(row["issn_l"].strip().upper())
        for issn in row.get("issn") or []:
            if issn:
                issns.add(issn.strip().upper())
    doaj_by_issn = doaj_lookup(sorted(issns))

    topics_per = TOPICS_PER_JOURNAL
    keep_cby = True
    journals, dropped = build_records(sources, volume, doaj_by_issn,
                                      topics_per, keep_cby)
    log("STEP 4  built %d records (%d dropped for missing display_name)"
        % (len(journals), dropped))

    out_path = os.path.join(DATA, "journals.json")

    def write(js):
        payload = {"generated": GENERATED, "source": "OpenAlex",
                   "apc_source": "DOAJ", "topic_count": len(topics),
                   "min_neuro_works": MIN_NEURO_WORKS,
                   "works_from_date": FROM_DATE,
                   "journal_count": len(js), "journals": js}
        with open(out_path, "w") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        return payload

    payload = write(journals)
    if os.path.getsize(out_path) > SIZE_CAP_MB * 1e6:
        log("  over %.1f MB -- trimming to 8 topics/journal, dropping counts_by_year"
            % SIZE_CAP_MB)
        journals, dropped = build_records(sources, volume, doaj_by_issn, 8, False)
        payload = write(journals)

    missing, size = validate(payload, out_path)
    log("")
    log("wrote %s" % out_path)
    log("wrote %s" % os.path.join(DATA, "topics.json"))
    if missing:
        raise SystemExit("FAILED: required journals missing: %s" % missing)


if __name__ == "__main__":
    main()
