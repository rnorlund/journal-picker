/**
 * engine.js — journal recommendation engine.
 *
 * Runs unchanged in the browser and in Node 22+ (both have global fetch).
 * Data source: the OpenAlex API (free, no key, CORS-open).
 *
 * Strategy: a multi-probe sweep rather than one long query. OpenAlex's `search`
 * ANDs its terms, so a 20-term query returns almost nothing. We instead fire
 * several short, differently-angled probes (core concept, title phrase, method,
 * population, broad) and merge them with rank decay. A separate topic-volume
 * probe answers "does this journal actually publish this kind of work, at
 * volume" — which relevance search alone cannot tell you.
 */

const OPENALEX = 'https://api.openalex.org';

/**
 * OpenAlex asks callers to identify themselves; doing so puts you in their
 * faster "polite pool". Set this to your own address before deploying.
 */
export const config = {
  mailto: 'journal-picker@your-institution.edu',
  /**
   * OpenAlex API key. As of 2026 the API is credit-metered and anonymous
   * allowances are small — a handful of searches before a lockout — so a key is
   * effectively required for real use. Each user supplies their own; a static
   * site cannot hold a shared secret.
   */
  apiKey: null,
  maxConcurrent: 3,
  minIntervalMs: 110,
  /** How many relevance probes to fire. Each costs ~10 OpenAlex credits. */
  maxProbes: 8,
};

/** Last seen credit accounting, read from OpenAlex response headers. */
export const quota = {
  limit: null, remaining: null, resetSeconds: null, lastCost: null,
};

/* ------------------------------------------------------------------ *
 * Text processing
 * ------------------------------------------------------------------ */

const STOPWORDS = new Set(`a an the of and or to in for with on by from as at is are was were be been
being this that these those we our us they their he she his her its it not no also can may might could
would should will shall do does did have has had than then thus so such but if when while which who whom
whose what how why where between among during after before over under above below up down out off very
more most less least much many few both each other another some any all none only own same too just
into through against across along around behind beside besides beyond within without upon toward towards
per via using used use based study studies result results method methods conclusion conclusions
background objective objectives purpose aim aims significance findings finding show shows shown
demonstrate demonstrated suggest suggests indicate indicates however moreover furthermore therefore
additionally respectively significant significantly compared comparison associated association
increase increased decrease decreased higher lower greater group groups participant participants
subject subjects patient patients control controls data analysis analyses analyzed measure measures
measured assess assessed examine examined investigate investigated evaluate evaluated report reported
present presented found observe observed test tested testing paper article manuscript here whether
respective within across also one two three four five new novel current present recent well may
including included include high low large small total mean average relative absolute overall
first second third finally further additional potential possible likely important role effect effects
difference differences change changes level levels number numbers time times year years age aged
male female men women human humans healthy normal
`.trim().split(/\s+/));

/** Imaging modalities / methods worth probing on their own. */
const MODALITY_LEXICON = [
  ['fmri', 'functional mri'], ['functional magnetic resonance', 'fmri'],
  ['resting state', 'resting state fmri'], ['resting-state', 'resting state fmri'],
  ['dti', 'diffusion tensor imaging'], ['diffusion tensor', 'diffusion tensor imaging'],
  ['diffusion weighted', 'diffusion weighted imaging'], ['tractography', 'tractography'],
  ['fractional anisotropy', 'fractional anisotropy'], ['dwi', 'diffusion weighted imaging'],
  ['noddi', 'diffusion microstructure'], ['free water', 'diffusion microstructure'],
  ['cortical thickness', 'cortical thickness'], ['voxel based morphometry', 'voxel based morphometry'],
  ['vbm', 'voxel based morphometry'], ['gray matter volume', 'gray matter volume'],
  ['grey matter volume', 'gray matter volume'], ['surface based', 'surface based morphometry'],
  ['freesurfer', 'freesurfer cortical surface'], ['fsl', 'fsl neuroimaging software'],
  ['spm', 'statistical parametric mapping'], ['afni', 'afni neuroimaging software'],
  ['fmriprep', 'fmriprep preprocessing'], ['bids', 'brain imaging data structure'],
  ['eeg', 'electroencephalography'], ['meg', 'magnetoencephalography'],
  ['erp', 'event related potentials'], ['event related potential', 'event related potentials'],
  ['pet', 'positron emission tomography'], ['positron emission', 'positron emission tomography'],
  ['tau pet', 'tau pet imaging'], ['amyloid', 'amyloid pet imaging'],
  ['spect', 'spect imaging'], ['fnirs', 'functional near infrared spectroscopy'],
  ['near infrared', 'functional near infrared spectroscopy'],
  ['spectroscopy', 'magnetic resonance spectroscopy'], ['mrs', 'magnetic resonance spectroscopy'],
  ['asl', 'arterial spin labeling'], ['arterial spin', 'arterial spin labeling'],
  ['perfusion', 'cerebral perfusion imaging'], ['qsm', 'quantitative susceptibility mapping'],
  ['susceptibility', 'quantitative susceptibility mapping'],
  ['functional connectivity', 'functional connectivity'],
  ['structural connectivity', 'structural connectivity'],
  ['connectome', 'connectome'], ['graph theory', 'brain network graph theory'],
  ['default mode', 'default mode network'], ['network analysis', 'brain network analysis'],
  ['lesion symptom mapping', 'lesion symptom mapping'],
  ['voxel based lesion', 'lesion symptom mapping'], ['vlsm', 'lesion symptom mapping'],
  ['lesion load', 'lesion load'], ['lesion volume', 'lesion volume'],
  ['machine learning', 'machine learning neuroimaging'],
  ['deep learning', 'deep learning neuroimaging'],
  ['convolutional neural network', 'deep learning neuroimaging'],
  ['brain age', 'brain age prediction'], ['predictive model', 'predictive modeling'],
  ['multivariate pattern', 'multivariate pattern analysis'], ['mvpa', 'multivariate pattern analysis'],
  ['representational similarity', 'representational similarity analysis'],
  ['tms', 'transcranial magnetic stimulation'],
  ['transcranial magnetic', 'transcranial magnetic stimulation'],
  ['tdcs', 'transcranial direct current stimulation'],
  ['transcranial direct current', 'transcranial direct current stimulation'],
  ['deep brain stimulation', 'deep brain stimulation'],
  ['7t', 'ultra high field mri'], ['ultra high field', 'ultra high field mri'],
  ['diffusion mri', 'diffusion mri'], ['structural mri', 'structural mri'],
  ['neuroimaging', 'neuroimaging'], ['mri', 'magnetic resonance imaging'],
];

/** Clinical populations / domains worth probing on their own. */
const POPULATION_LEXICON = [
  ['aphasia', 'aphasia'], ['anomia', 'anomia naming'], ['stroke', 'stroke'],
      ['alzheimer', 'alzheimers disease'], ['dementia', 'dementia'],
  ['mild cognitive impairment', 'mild cognitive impairment'], ['mci', 'mild cognitive impairment'],
  ['parkinson', 'parkinsons disease'], ['epilepsy', 'epilepsy'],
  ['multiple sclerosis', 'multiple sclerosis'], ['traumatic brain injury', 'traumatic brain injury'],
  ['tbi', 'traumatic brain injury'], ['concussion', 'concussion'],
  ['schizophrenia', 'schizophrenia'], ['psychosis', 'psychosis'], ['bipolar', 'bipolar disorder'],
  ['depression', 'major depressive disorder'], ['anxiety', 'anxiety disorder'],
  ['ptsd', 'post traumatic stress disorder'], ['ocd', 'obsessive compulsive disorder'],
  ['autism', 'autism spectrum disorder'], ['adhd', 'attention deficit hyperactivity disorder'],
  ['dyslexia', 'dyslexia'], ['aging', 'aging brain'], ['ageing', 'aging brain'],
  ['development', 'brain development'], ['adolescent', 'adolescent brain development'],
  ['infant', 'infant brain development'], ['neonatal', 'neonatal brain imaging'],
  ['pediatric', 'pediatric neuroimaging'], ['glioma', 'glioma'], ['tumor', 'brain tumor'],
  ['chronic pain', 'chronic pain'], ['addiction', 'addiction'],
  ['substance use', 'substance use disorder'], ['language', 'language'],
  ['bilingual', 'bilingualism'], ['memory', 'memory'], ['attention', 'attention'],
  ['executive function', 'executive function'], ['reward', 'reward processing'],
  ['emotion', 'emotion'], ['sleep', 'sleep'], ['motor', 'motor control'],
  ['rehabilitation', 'neurorehabilitation'], ['recovery', 'recovery'],
  ['biomarker', 'imaging biomarker'], ['prognosis', 'prognosis'],
  ['small vessel disease', 'cerebral small vessel disease'],
  ['white matter hyperintensit', 'white matter hyperintensities'],
];

/** Venues that are not journals you submit a manuscript to. */
const NON_JOURNAL_HINTS = [
  'biorxiv', 'medrxiv', 'arxiv', 'research square', 'ssrn', 'preprints.org',
  'zenodo', 'figshare', 'dryad', 'osf', 'openneuro', 'dans', 'researchgate',
  'semantic scholar', 'core', 'hal', 'dspace', 'repositor', 'authorea',
  'social science research network', 'elsevier bv', 'pubmed central',
];

const tokenize = (text) =>
  (text || '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .match(/[a-z][a-z\-']{2,}/g) || [];

const contentTokens = (text) => tokenize(text).filter((w) => !STOPWORDS.has(w));

/** Detect multi-word lexicon hits in raw text. */
function detectLexicon(text, lexicon) {
  const hay = ` ${(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const hits = [];
  const seen = new Set();
  for (const [needle, probe] of lexicon) {
    if (hay.includes(` ${needle}`) && !seen.has(probe)) {
      seen.add(probe);
      hits.push(probe);
    }
  }
  return hits;
}

/**
 * Pull the query-worthy content out of a manuscript.
 */
export function extractKeywords(title, abstract) {
  const titleTokens = contentTokens(title);
  const absTokens = contentTokens(abstract);
  const full = `${title || ''} ${abstract || ''}`;

  const tf = new Map();
  const bump = (w, wt) => tf.set(w, (tf.get(w) || 0) + wt);
  titleTokens.forEach((w) => bump(w, 3.0));
  absTokens.forEach((w) => bump(w, 1.0));

  // Bigrams, title-weighted. Only keep ones that recur or come from the title.
  const bg = new Map();
  const addBigrams = (seq, wt) => {
    for (let i = 0; i < seq.length - 1; i++) {
      const k = `${seq[i]} ${seq[i + 1]}`;
      bg.set(k, (bg.get(k) || 0) + wt);
    }
  };
  addBigrams(titleTokens, 3.0);
  addBigrams(absTokens, 1.0);

  const terms = [...tf.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  const phrases = [...bg.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p);

  return {
    terms,
    phrases,
    titleTerms: [...new Set(titleTokens)],
    modalities: detectLexicon(full, MODALITY_LEXICON),
    populations: detectLexicon(full, POPULATION_LEXICON),
  };
}

/**
 * Build the probe set. Each probe is a short query (3-5 terms) aimed at a
 * different facet of the manuscript, so their union has real recall while each
 * individually stays precise.
 */
export function buildProbes(kw) {
  const probes = [];
  const push = (label, parts, weight) => {
    const q = parts.filter(Boolean).join(' ').trim();
    if (!q || probes.some((p) => p.query === q)) return;
    probes.push({ label, query: q, weight });
  };

  const t = kw.terms;
  const mod = kw.modalities;
  const pop = kw.populations;

  // Core: the strongest content terms overall.
  push('core', t.slice(0, 4), 1.0);
  // Title phrase: the manuscript's own framing.
  push('title-phrase', [kw.phrases[0], t[0]], 1.0);
  // Method x topic: what technique, applied to what.
  push('method', [mod[0], pop[0] || t[0]], 0.9);
  push('method-2', [mod[1], mod[0]], 0.75);
  // Population x method: the clinical/appplied angle.
  push('population', [pop[0], mod[0] || t[0]], 0.9);
  push('population-2', [pop[1], pop[0]], 0.7);
  // Broad: high recall backstop, lower weight.
  push('broad', t.slice(0, 2), 0.6);
  // Second phrase.
  push('phrase-2', [kw.phrases[1]], 0.7);

  return probes.slice(0, config.maxProbes);
}

/* ------------------------------------------------------------------ *
 * API access
 * ------------------------------------------------------------------ */

const WORK_SELECT = [
  'id', 'doi', 'title', 'publication_year', 'type', 'cited_by_count',
  'primary_location', 'topics', 'relevance_score', 'open_access',
].join(',');

function withAuth(url) {
  const sep = url.includes('?') ? '&' : '?';
  let out = `${url}${sep}mailto=${encodeURIComponent(config.mailto)}`;
  if (config.apiKey) out += `&api_key=${encodeURIComponent(config.apiKey)}`;
  return out;
}

/** OpenAlex exposes its rate-limit headers to browsers, so we can show the
 *  remaining budget instead of letting users hit a wall blind. */
function readQuota(res) {
  const num = (h) => {
    const v = res.headers.get(h);
    return v == null || v === '' ? null : Number(v);
  };
  const limit = num('x-ratelimit-limit');
  const remaining = num('x-ratelimit-remaining');
  if (limit != null) quota.limit = limit;
  if (remaining != null) quota.remaining = remaining;
  const reset = num('x-ratelimit-reset');
  if (reset != null) quota.resetSeconds = reset;
  const cost = num('x-ratelimit-credits-required');
  if (cost != null) quota.lastCost = cost;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A small gate that keeps us inside OpenAlex's rate limits: at most
 * `maxConcurrent` requests in flight, spaced by `minIntervalMs`. Without this,
 * firing every probe at once reliably earns a burst of 429s.
 */
const gate = (() => {
  let active = 0;
  let lastStart = 0;
  const waiting = [];

  const pump = () => {
    if (active >= config.maxConcurrent || !waiting.length) return;
    const wait = Math.max(0, lastStart + config.minIntervalMs - Date.now());
    const next = waiting.shift();
    active++;
    setTimeout(() => {
      lastStart = Date.now();
      next();
    }, wait);
  };

  return async function schedule(fn) {
    await new Promise((resolve) => { waiting.push(resolve); pump(); });
    try {
      return await fn();
    } finally {
      active--;
      pump();
    }
  };
})();

async function apiGet(url, { retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await gate(async () => {
        const res = await fetch(withAuth(url), { headers: { Accept: 'application/json' } });
        readQuota(res);

        if (res.status === 429) {
          const retryAfter = parseFloat(res.headers.get('retry-after') || '0');
          // A long reset means the credit budget is spent, not that we are
          // simply going too fast. Retrying cannot help; say so plainly.
          if (retryAfter > 90) {
            const mins = Math.ceil(retryAfter / 60);
            const err = new Error(
              `OpenAlex credit limit reached${config.apiKey ? '' : ' for anonymous use'}. ` +
              `Resets in about ${mins} minute${mins === 1 ? '' : 's'}.` +
              (config.apiKey ? '' : ' Add a free OpenAlex API key to raise the limit.'));
            err.quotaExhausted = true;
            throw err;
          }
          const err = new Error('OpenAlex rate limit — backing off');
          err.retryAfterMs = retryAfter > 0 ? retryAfter * 1000 : null;
          err.transient = true;
          throw err;
        }
        if (res.status >= 500) {
          const err = new Error(`OpenAlex ${res.status}`);
          err.transient = true;
          throw err;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`OpenAlex ${res.status}: ${body.slice(0, 200)}`);
        }
        return await res.json();
      });
    } catch (err) {
      lastErr = err;
      if (err.quotaExhausted) throw err; // retrying cannot buy credits
      if (attempt >= retries || (!err.transient && !/fetch|network/i.test(err.message))) {
        throw err;
      }
      // Exponential backoff with jitter, or whatever the server asked for.
      const base = err.retryAfterMs ?? Math.min(600 * 2 ** attempt, 8000);
      await sleep(base + Math.random() * 300);
    }
  }
  throw lastErr;
}

/** Run one relevance probe. */
async function runProbe(probe, { yearsFrom, perPage = 100 }) {
  const url =
    `${OPENALEX}/works?search=${encodeURIComponent(probe.query)}` +
    `&filter=from_publication_date:${yearsFrom}-01-01,type:article` +
    `&select=${WORK_SELECT}&per-page=${perPage}`;
  const data = await apiGet(url);
  return { probe, total: data.meta?.count ?? 0, works: data.results || [] };
}

/** Journal publication volume within a set of topics. */
async function topicVolume(topicIds, { yearsFrom }) {
  if (!topicIds.length) return new Map();
  const url =
    `${OPENALEX}/works?filter=topics.id:${topicIds.join('|')},` +
    `from_publication_date:${yearsFrom}-01-01,type:article` +
    `&group_by=primary_location.source.id&per-page=200`;
  const data = await apiGet(url);
  const out = new Map();
  for (const g of data.group_by || []) {
    if (!g.key || g.key === 'unknown') continue;
    out.set(bareId(g.key), { count: g.count, name: g.key_display_name });
  }
  return out;
}

const SOURCE_SELECT = [
  'id', 'display_name', 'alternate_titles', 'issn', 'issn_l', 'is_oa', 'is_in_doaj',
  'is_core', 'is_preprint_repository', 'apc_usd', 'apc_prices', 'type',
  'host_organization_name', 'homepage_url', 'works_count', 'summary_stats', 'topics',
].join(',');

/** Fetch journal metadata in batches of 50. */
async function fetchSources(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url =
      `${OPENALEX}/sources?filter=openalex:${batch.join('|')}` +
      `&select=${SOURCE_SELECT}&per-page=50`;
    const data = await apiGet(url);
    for (const s of data.results || []) out.set(bareId(s.id), s);
  }
  return out;
}

export const bareId = (id) => (id || '').replace(/^https?:\/\/openalex\.org\//, '');

/* ------------------------------------------------------------------ *
 * DOAJ: the authoritative source for open-access charges
 *
 * OpenAlex reports apc_usd = null for two very different situations: the
 * journal charges nothing, and nobody recorded a price. That ambiguity makes
 * it impossible to tell diamond OA from unknown, which matters a lot if you
 * are trying to publish for free. DOAJ records an explicit has_apc boolean,
 * so we ask it directly. Free API, no key, CORS-open.
 * ------------------------------------------------------------------ */

const DOAJ = 'https://doaj.org/api/search/journals';

/** Rough conversion, only ever used for filtering/sorting — the original
 *  currency and amount are always what we display. */
const USD_PER = { USD: 1, EUR: 1.08, GBP: 1.27, CHF: 1.12, JPY: 0.0065, CAD: 0.73, AUD: 0.66, SEK: 0.095, DKK: 0.145, NOK: 0.093, BRL: 0.18, INR: 0.012, CNY: 0.14, PLN: 0.25, TRY: 0.03, ZAR: 0.055 };

const toUsd = (price, currency) => {
  const rate = USD_PER[(currency || 'USD').toUpperCase()];
  return rate ? Math.round(price * rate) : null;
};

/**
 * Look up APC facts for a set of ISSNs. Returns Map<issn, info>, with every
 * ISSN of a matched journal pointing at the same record.
 */
async function fetchDoajApc(issns) {
  const out = new Map();
  const unique = [...new Set(issns.filter(Boolean))];

  for (let i = 0; i < unique.length; i += 40) {
    const batch = unique.slice(i, i + 40);
    const query = `issn:(${batch.join(' OR ')})`;
    const url = `${DOAJ}/${encodeURIComponent(query)}?pageSize=100`;
    let data;
    try {
      data = await gate(async () => {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`DOAJ ${res.status}`);
        return res.json();
      });
    } catch {
      continue; // DOAJ is an enhancement; never fail the whole run over it
    }

    for (const r of data.results || []) {
      const b = r.bibjson || {};
      const apc = b.apc || {};
      const max = (apc.max || [])[0] || null;
      const price = max?.price ?? null;
      const currency = max?.currency ?? null;

      const info = {
        title: b.title || null,
        hasApc: typeof apc.has_apc === 'boolean' ? apc.has_apc : null,
        price,
        currency,
        priceUsd: price != null ? toUsd(price, currency) : (apc.has_apc === false ? 0 : null),
        apcUrl: apc.url || null,
        inDoaj: true,
      };
      for (const issn of [b.pissn, b.eissn, ...(b.identifier || []).map((x) => x.id)]) {
        if (issn) out.set(String(issn).toUpperCase(), info);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

const CURRENT_YEAR = 2026;

/** Rank decay: top hits count much more than tail hits. */
const rankWeight = (i) => 1 / (1 + i * 0.06);

/** Recent papers are stronger evidence of current scope. */
function recencyWeight(year) {
  if (!year) return 0.6;
  const age = CURRENT_YEAR - year;
  if (age <= 1) return 1.15;
  if (age <= 3) return 1.0;
  if (age <= 5) return 0.82;
  return 0.65;
}

const normalize = (map, key) => {
  const max = Math.max(...[...map.values()].map((v) => v[key]), 0);
  if (max <= 0) return;
  for (const v of map.values()) v[`${key}Norm`] = v[key] / max;
};

function looksNonJournal(source, name) {
  if (source?.is_preprint_repository) return true;
  const type = source?.type;
  if (type && !['journal', 'conference', 'book series'].includes(type)) return true;
  const hay = (name || source?.display_name || '').toLowerCase();
  return NON_JOURNAL_HINTS.some((h) => hay.includes(h));
}

/**
 * Resolve open-access model and price, preferring DOAJ's explicit has_apc flag
 * over OpenAlex's ambiguous null. Returns the model plus the price we trust.
 */
export function classifyOa(source, doaj) {
  const oaApc = source.apc_usd;
  const isOa = !!source.is_oa;

  // DOAJ said, definitively, that there is no charge.
  if (doaj?.hasApc === false) {
    return { model: 'diamond', apc: 0, apcSource: 'DOAJ', apcUrl: doaj.apcUrl };
  }
  // DOAJ has a price.
  if (doaj?.hasApc === true && doaj.priceUsd != null) {
    return {
      model: isOa ? 'gold' : 'hybrid',
      apc: doaj.priceUsd,
      apcSource: 'DOAJ',
      apcUrl: doaj.apcUrl,
      nativePrice: doaj.price,
      nativeCurrency: doaj.currency,
    };
  }
  // Fall back to OpenAlex.
  if (oaApc === 0) return { model: 'diamond', apc: 0, apcSource: 'OpenAlex' };
  if (oaApc != null && oaApc > 0) {
    return { model: isOa ? 'gold' : 'hybrid', apc: oaApc, apcSource: 'OpenAlex' };
  }
  if (isOa) return { model: 'oa-apc-unknown', apc: null, apcSource: null };
  return { model: 'subscription', apc: null, apcSource: null };
}

/**
 * The main entry point.
 *
 * @param {object}   input
 * @param {string}   input.title
 * @param {string}   input.abstract
 * @param {object}   [opts]
 * @param {number}   [opts.yearsFrom]   earliest publication year to consider
 * @param {function} [opts.onProgress]  (stage, detail) => void
 */
export async function recommend({ title, abstract }, opts = {}) {
  const yearsFrom = opts.yearsFrom || CURRENT_YEAR - 7;
  const progress = opts.onProgress || (() => {});

  const text = `${title || ''} ${abstract || ''}`.trim();
  if (text.length < 40) {
    throw new Error('Please paste a title and abstract (at least a couple of sentences).');
  }

  const kw = extractKeywords(title, abstract);
  const probes = buildProbes(kw);
  progress('probes', { probes: probes.map((p) => ({ label: p.label, query: p.query })) });

  // --- Stage 1: parallel relevance probes -------------------------------
  const settled = await Promise.allSettled(
    probes.map((p) => runProbe(p, { yearsFrom })),
  );
  const probeResults = settled
    .filter((s) => s.status === 'fulfilled')
    .map((s) => s.value);
  const probeErrors = settled
    .filter((s) => s.status === 'rejected')
    .map((s) => String(s.reason?.message || s.reason));

  const exhausted = settled.find((s) => s.status === 'rejected' && s.reason?.quotaExhausted);
  if (exhausted && probeResults.length < 2) throw exhausted.reason;
  if (!probeResults.length) {
    throw new Error(`Could not reach OpenAlex. ${probeErrors[0] || ''}`.trim());
  }

  const matchedWorks = new Map(); // workId -> work (deduped across probes)
  const venues = new Map();       // sourceId -> accumulator
  const topicScores = new Map();  // topicId -> {score, name}

  for (const { probe, works } of probeResults) {
    works.forEach((w, i) => {
      const rw = rankWeight(i) * probe.weight;

      for (const t of (w.topics || []).slice(0, 2)) {
        const id = bareId(t.id);
        const cur = topicScores.get(id) || { score: 0, name: t.display_name };
        cur.score += rw;
        topicScores.set(id, cur);
      }

      if (!matchedWorks.has(w.id)) matchedWorks.set(w.id, w);

      const src = w.primary_location?.source;
      if (!src?.id) return;
      const sid = bareId(src.id);

      let v = venues.get(sid);
      if (!v) {
        v = {
          id: sid,
          name: src.display_name,
          issn_l: src.issn_l || null,
          sim: 0,
          hits: 0,
          probeLabels: new Set(),
          papers: new Map(), // workId -> paper, so cross-probe agreement survives
          years: [],
        };
        venues.set(sid, v);
      }
      v.sim += rw * recencyWeight(w.publication_year);
      v.hits += 1;
      v.probeLabels.add(probe.label);
      v.years.push(w.publication_year);

      // A paper found by several different probes matches more facets of the
      // manuscript, so it is genuinely more similar than one that merely
      // ranked first on a single narrow query.
      let paper = v.papers.get(w.id);
      if (!paper) {
        paper = {
          title: w.title,
          year: w.publication_year,
          doi: w.doi,
          cites: w.cited_by_count,
          oa: !!w.open_access?.is_oa,
          score: 0,
          probes: new Set(),
        };
        v.papers.set(w.id, paper);
      }
      paper.score += rw * recencyWeight(w.publication_year);
      paper.probes.add(probe.label);
    });
  }

  progress('retrieved', {
    works: matchedWorks.size,
    venues: venues.size,
    probes: probeResults.map((r) => ({ label: r.probe.label, query: r.probe.query, total: r.total, got: r.works.length })),
    errors: probeErrors,
  });

  // --- Stage 2: topic-volume probe --------------------------------------
  const topTopics = [...topicScores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 6)
    .map(([id, v]) => ({ id, name: v.name, score: +v.score.toFixed(2) }));

  let volume = new Map();
  try {
    volume = await topicVolume(topTopics.slice(0, 4).map((t) => t.id), { yearsFrom });
  } catch {
    /* non-fatal: similarity alone still ranks */
  }
  progress('topics', { topics: topTopics, volumeVenues: volume.size });

  // Journals with real topical volume but no direct relevance hit still deserve
  // consideration — they are exactly the "publishes this kind of work" cases.
  for (const [sid, info] of volume) {
    if (!venues.has(sid) && info.count >= 25) {
      venues.set(sid, {
        id: sid, name: info.name, issn_l: null, sim: 0, hits: 0,
        probeLabels: new Set(), papers: [], years: [],
      });
    }
  }
  for (const [sid, v] of venues) v.vol = volume.get(sid)?.count || 0;

  // --- Stage 3: enrich the shortlist ------------------------------------
  const shortlist = [...venues.values()]
    .map((v) => ({ v, pre: v.sim * 2 + Math.log1p(v.vol) * 0.5 }))
    .sort((a, b) => b.pre - a.pre)
    .slice(0, 120)
    .map((x) => x.v);

  const sources = await fetchSources(shortlist.map((v) => v.id));
  progress('enriched', { sources: sources.size });

  // Resolve real APC facts from DOAJ for everything with an ISSN.
  const allIssns = [];
  for (const s of sources.values()) {
    for (const issn of s.issn || []) allIssns.push(issn);
    if (s.issn_l) allIssns.push(s.issn_l);
  }
  let doajMap = new Map();
  try {
    doajMap = await fetchDoajApc(allIssns);
  } catch { /* enhancement only */ }
  progress('apc', { doajMatched: doajMap.size });

  const doajFor = (s) => {
    for (const issn of [...(s.issn || []), s.issn_l]) {
      if (!issn) continue;
      const hit = doajMap.get(String(issn).toUpperCase());
      if (hit) return hit;
    }
    return null;
  };

  // --- Stage 4: score ---------------------------------------------------
  const scoreMap = new Map();
  for (const v of shortlist) {
    const s = sources.get(v.id);
    if (!s) continue;
    scoreMap.set(v.id, { v, s, sim: v.sim, vol: v.vol });
  }
  normalize(scoreMap, 'sim');
  normalize(scoreMap, 'vol');

  const results = [];
  for (const entry of scoreMap.values()) {
    const { v, s } = entry;
    const simN = entry.simNorm || 0;
    // log-compress volume so a mega-journal doesn't dominate on size alone
    const volRaw = Math.log1p(v.vol);
    const volMax = Math.log1p(Math.max(...[...scoreMap.values()].map((e) => e.vol), 1));
    const volN = volMax > 0 ? volRaw / volMax : 0;

    // Breadth bonus: matching several different probes means the journal fits
    // the whole manuscript, not just one keyword.
    const breadth = Math.min(v.probeLabels.size / 4, 1);

    const fit = 0.55 * simN + 0.30 * volN + 0.15 * breadth;

    const doaj = doajFor(s);
    const oa = classifyOa(s, doaj);
    const apc = oa.apc;
    const oaModel = oa.model;
    const stats = s.summary_stats || {};
    // Rank the showcase papers by how many facets of the manuscript they hit,
    // then by accumulated relevance — not by any single probe's top hit.
    const papers = [...v.papers.values()]
      .sort((a, b) =>
        (b.probes.size - a.probes.size) ||
        (b.score - a.score) ||
        ((b.year || 0) - (a.year || 0)))
      .slice(0, 5)
      .map((p) => ({
        title: p.title,
        year: p.year,
        doi: p.doi,
        cites: p.cites,
        oa: p.oa,
        facets: p.probes.size,
      }));

    results.push({
      id: v.id,
      name: s.display_name,
      altNames: s.alternate_titles || [],
      publisher: s.host_organization_name || null,
      homepage: s.homepage_url || null,
      issns: s.issn || (s.issn_l ? [s.issn_l] : []),
      issn_l: s.issn_l || null,
      type: s.type || null,
      isJournal: !looksNonJournal(s, v.name),
      isPreprint: !!s.is_preprint_repository,
      isOa: !!s.is_oa,
      inDoaj: !!s.is_in_doaj,
      isCore: !!s.is_core,
      apcUsd: apc,
      apcKnown: apc != null,
      apcSource: oa.apcSource,
      apcUrl: oa.apcUrl || null,
      apcNative: oa.nativePrice != null ? { price: oa.nativePrice, currency: oa.nativeCurrency } : null,
      apcPrices: s.apc_prices || null,
      oaModel,
      worksCount: s.works_count || 0,
      hIndex: stats.h_index ?? null,
      citedness: stats['2yr_mean_citedness'] != null ? +stats['2yr_mean_citedness'].toFixed(2) : null,
      // evidence
      fit: +fit.toFixed(4),
      simScore: +v.sim.toFixed(3),
      simNorm: +simN.toFixed(3),
      matchCount: v.hits,
      topicWorks: v.vol,
      probesMatched: [...v.probeLabels],
      samplePapers: papers,
      journalTopics: (s.topics || []).slice(0, 8).map((t) => ({
        id: bareId(t.id), name: t.display_name, count: t.count,
      })),
    });
  }

  results.sort((a, b) => b.fit - a.fit);

  return {
    query: { title, abstract, yearsFrom },
    keywords: kw,
    probes: probeResults.map((r) => ({
      label: r.probe.label, query: r.probe.query, total: r.total, returned: r.works.length,
    })),
    probeErrors,
    topics: topTopics,
    worksExamined: matchedWorks.size,
    venuesConsidered: venues.size,
    journals: results,
  };
}
