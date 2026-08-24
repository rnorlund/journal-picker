/**
 * engine.js — journal recommendation engine (v2).
 *
 * Runs unchanged in the browser and in Node 22+ (both have global fetch).
 *
 * Architecture
 * ------------
 * Retrieval    Europe PMC  — free, no API key, no credit metering, CORS-open,
 *                            real boolean queries, 1,000 results per call.
 * Journal data Precomputed catalog (data/journals.json), built offline from
 *                            OpenAlex + DOAJ by scripts/build-catalog.py.
 * Fields       data/fields/*.json — methods and population lexicons per
 *                            discipline, auto-detected from the manuscript.
 *
 * Nothing here is metered, so the public site works for a visitor with no key.
 * v1 used OpenAlex for retrieval, which cost ~80 credits per search and locked
 * out anonymous users after a handful of queries.
 */

import { loadFields, detectFields } from './fields.js';
import { loadCatalogs, lookup, normIssn, normTitle } from './catalog.js';
import { buildGazetteer, matchCitations, citationAffinity, estimateRefCount } from './citations.js';

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

export const config = {
  /** Optional contact address, sent to Europe PMC as `email` if set. */
  email: null,
  maxConcurrent: 3,
  minIntervalMs: 80,
  /** Results requested per query (Europe PMC allows 1000). */
  pageSize: 1000,
  /** Earliest publication year considered. */
  sinceYear: 2019,
  /** Where the data files live, relative to the page. */
  dataBase: 'data',
};

/** Retained for UI compatibility; nothing in v2 is credit-metered. */
export const quota = { limit: null, remaining: null, resetSeconds: null, lastCost: null };

const CURRENT_YEAR = 2026;

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

const tokenize = (text) =>
  (text || '').toLowerCase().replace(/[‐-―]/g, '-').match(/[a-z][a-z\-']{2,}/g) || [];

const contentTokens = (text) => tokenize(text).filter((w) => !STOPWORDS.has(w));

/** Pull the query-worthy content out of a manuscript. */
export function extractKeywords(title, abstract) {
  const titleTokens = contentTokens(title);
  const absTokens = contentTokens(abstract);

  const tf = new Map();
  const bump = (w, wt) => tf.set(w, (tf.get(w) || 0) + wt);
  titleTokens.forEach((w) => bump(w, 3.0));
  absTokens.forEach((w) => bump(w, 1.0));

  const bg = new Map();
  const addBigrams = (seq, wt) => {
    for (let i = 0; i < seq.length - 1; i++) {
      const k = `${seq[i]} ${seq[i + 1]}`;
      bg.set(k, (bg.get(k) || 0) + wt);
    }
  };
  addBigrams(titleTokens, 3.0);
  addBigrams(absTokens, 1.0);

  return {
    terms: [...tf.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w),
    phrases: [...bg.entries()].filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1]).map(([p]) => p),
    titleTerms: [...new Set(titleTokens)],
  };
}

/* ------------------------------------------------------------------ *
 * Query construction
 *
 * Europe PMC supports genuine boolean queries, so one well-formed OR-group
 * replaces what OpenAlex needed eight separate AND-only probes to cover.
 * ------------------------------------------------------------------ */

const quote = (t) => (t.includes(' ') ? `"${t}"` : t);
const orGroup = (terms) => `(${terms.map(quote).join(' OR ')})`;

export function buildQueries(kw, detected) {
  const dateClause = `(FIRST_PDATE:[${config.sinceYear} TO ${CURRENT_YEAR}])`;
  const queries = [];
  const push = (label, clauses, weight) => {
    const q = `${clauses.filter(Boolean).join(' AND ')} AND ${dateClause}`;
    if (!queries.some((x) => x.query === q)) queries.push({ label, query: q, weight });
  };

  const methods = detected.methods.slice(0, 6);
  const pops = detected.populations.slice(0, 5);
  const phrases = kw.phrases.slice(0, 4);
  const terms = kw.terms;

  // The sharpest signal: this technique applied to this population.
  if (methods.length && pops.length) {
    push('method × population', [orGroup(methods), orGroup(pops)], 1.0);
  }
  // The manuscript's own framing.
  if (phrases.length) {
    push('key phrases', [orGroup(phrases)], 0.95);
  }
  // Whichever axis we have on its own, tightened with the strongest terms.
  if (methods.length && !pops.length) {
    push('methods', [orGroup(methods), orGroup(terms.slice(0, 4))], 0.85);
  }
  if (pops.length && !methods.length) {
    push('populations', [orGroup(pops), orGroup(terms.slice(0, 4))], 0.85);
  }
  // Backstop that needs no lexicon at all, so unrecognised fields still work.
  push('core terms', [terms.slice(0, 3).map(quote).join(' AND ')], 0.7);

  return queries.slice(0, 4);
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gate = (() => {
  let active = 0, lastStart = 0;
  const waiting = [];
  const pump = () => {
    if (active >= config.maxConcurrent || !waiting.length) return;
    const wait = Math.max(0, lastStart + config.minIntervalMs - Date.now());
    const next = waiting.shift();
    active++;
    setTimeout(() => { lastStart = Date.now(); next(); }, wait);
  };
  return async function schedule(fn) {
    await new Promise((resolve) => { waiting.push(resolve); pump(); });
    try { return await fn(); } finally { active--; pump(); }
  };
})();

async function epmcSearch(query, { retries = 3 } = {}) {
  const params = new URLSearchParams({
    query,
    format: 'json',
    pageSize: String(config.pageSize),
    resultType: 'lite',
  });
  if (config.email) params.set('email', config.email);
  const url = `${EPMC}?${params}`;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await gate(async () => {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (res.status === 429 || res.status >= 500) {
          const err = new Error(`Europe PMC ${res.status}`);
          err.transient = true;
          throw err;
        }
        if (!res.ok) throw new Error(`Europe PMC ${res.status}`);
        return res.json();
      });
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      await sleep(500 * 2 ** attempt + Math.random() * 250);
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

const rankWeight = (i) => 1 / (1 + i * 0.05);

function recencyWeight(year) {
  if (!year) return 0.6;
  const age = CURRENT_YEAR - year;
  if (age <= 1) return 1.15;
  if (age <= 3) return 1.0;
  if (age <= 5) return 0.82;
  return 0.65;
}

/** Venues that are not journals you submit a finished manuscript to. */
const NON_JOURNAL = /biorxiv|medrxiv|arxiv|research square|ssrn|preprint|zenodo|figshare|dryad|^osf$/i;

/**
 * Recommend journals for a manuscript.
 *
 * @param {{title: string, abstract: string, references?: string}} input
 * @param {{onProgress?: (stage: string, detail: object) => void}} [opts]
 */
export async function recommend({ title, abstract, references }, opts = {}) {
  const progress = opts.onProgress || (() => {});
  const text = `${title || ''} ${abstract || ''}`.trim();
  if (text.length < 40) {
    throw new Error('Please paste a title and abstract (at least a couple of sentences).');
  }

  // --- Stage 0: field detection, then the catalogs those fields need -----
  const fields = await loadFields(`${config.dataBase}/fields`);
  const detected = detectFields(text, fields);
  const kw = extractKeywords(title, abstract);
  const queries = buildQueries(kw, detected);

  // Load only the detected fields' catalogs; if we recognised nothing, load
  // everything available rather than leaving the author with no cost data.
  const catalog = await loadCatalogs(
    detected.matched.map((m) => m.field.id), config.dataBase);

  progress('fields', {
    matched: detected.matched.map((m) => ({ id: m.field.id, name: m.field.name, score: m.score })),
    methods: detected.methods,
    populations: detected.populations,
    catalog: catalog ? catalog.size : 0,
    catalogFields: catalog ? catalog.fields : [],
  });
  // Which journals does the author already cite? Only they can tell us this,
  // and it is the single strongest signal of where the work belongs.
  let cited = { byId: new Map(), total: 0, refCount: 0 };
  let citeAff = new Map();
  if (references && references.trim() && catalog) {
    cited = matchCitations(references, buildGazetteer(catalog));
    citeAff = citationAffinity(cited.byId);
    progress('citations', {
      matched: cited.byId.size, total: cited.total, refCount: cited.refCount,
    });
  }

  progress('probes', { probes: queries.map((q) => ({ label: q.label, query: q.query })) });

  // --- Stage 1: retrieval ----------------------------------------------
  const settled = await Promise.allSettled(queries.map((q) => epmcSearch(q.query)));
  const runs = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') runs.push({ q: queries[i], data: s.value });
    else errors.push(String(s.reason?.message || s.reason));
  });
  if (!runs.length) {
    throw new Error(`Could not reach Europe PMC. ${errors[0] || ''}`.trim());
  }

  // --- Stage 2: aggregate by venue -------------------------------------
  const venues = new Map();
  const seenWorks = new Set();

  for (const { q, data } of runs) {
    const results = data.resultList?.result || [];
    results.forEach((r, i) => {
      // Europe PMC's `lite` gives an abbreviated journalTitle but a real ISSN,
      // so the ISSN is the reliable join key.
      const issn = normIssn(r.journalIssn);
      const jt = r.journalTitle || '';
      if (!issn && !jt) return;
      if (NON_JOURNAL.test(jt)) return;

      const key = issn || `t:${normTitle(jt)}`;
      const rw = rankWeight(i) * q.weight;
      const year = parseInt(r.pubYear, 10) || null;

      let v = venues.get(key);
      if (!v) {
        v = { key, issn, title: jt, sim: 0, hits: 0, labels: new Set(), papers: new Map() };
        venues.set(key, v);
      }
      v.sim += rw * recencyWeight(year);
      v.hits += 1;
      v.labels.add(q.label);

      const wid = r.doi || r.id;
      if (!seenWorks.has(wid)) seenWorks.add(wid);
      let p = v.papers.get(wid);
      if (!p) {
        p = {
          title: r.title, year, doi: r.doi ? `https://doi.org/${r.doi}` : null,
          cites: r.citedByCount ?? null, oa: r.isOpenAccess === 'Y',
          score: 0, probes: new Set(),
        };
        v.papers.set(wid, p);
      }
      p.score += rw;
      p.probes.add(q.label);
    });
  }

  progress('retrieved', {
    works: seenWorks.size,
    venues: venues.size,
    probes: runs.map((r) => ({
      label: r.q.label, query: r.q.query,
      total: r.data.hitCount ?? 0, returned: (r.data.resultList?.result || []).length,
    })),
    errors,
  });

  // A journal the author cites is a candidate even if retrieval missed it.
  // Otherwise the venue they cite most can be absent from its own results —
  // which is exactly what happened before this was added.
  let injected = 0;
  for (const { journal, count } of cited.byId.values()) {
    const issn = (journal._issns && journal._issns[0]) || null;
    const key = issn || `t:${normTitle(journal.display_name)}`;
    if (venues.has(key)) continue;
    venues.set(key, {
      key, issn, title: journal.display_name,
      sim: 0, hits: 0, labels: new Set(), papers: new Map(), fromCitation: count,
    });
    injected++;
  }
  if (injected) progress('injected', { fromCitations: injected });

  // --- Stage 3: join to the catalog and score --------------------------
  const maxSim = Math.max(...[...venues.values()].map((v) => v.sim), 1);
  const maxVol = Math.max(
    ...[...venues.values()].map((v) => {
      const rec = lookup(catalog, { issns: [v.issn], title: v.title });
      return rec?.fieldWorks || 0;
    }), 1);

  const results = [];
  for (const v of venues.values()) {
    const rec = lookup(catalog, { issns: [v.issn], title: v.title });

    const simN = v.sim / maxSim;
    const volN = Math.log1p(rec?.fieldWorks || 0) / Math.log1p(maxVol);
    const breadth = Math.min(v.labels.size / Math.max(queries.length - 1, 1), 1);

    // Specialisation: what fraction of this journal's output is in your field.
    // Without it, pay-to-publish mega-journals dominate on raw volume alone —
    // Cureus publishes ~6k in-field papers but they are only 5% of its output,
    // where Brain Communications is 54% in-field. Saturates at 25% so genuine
    // specialists are not penalised for also publishing adjacent work.
    const share = rec?.fieldShare ?? 0;
    const spec = Math.min(share / 0.25, 1);

    // Citation affinity, when the author gave us a reference list.
    const citedEntry = rec ? cited.byId.get(rec.id) : null;
    const citedCount = citedEntry ? citedEntry.count : 0;
    const cite = rec ? (citeAff.get(rec.id) || 0) : 0;

    // With a reference list, citations are direct evidence from the person who
    // actually knows the work, so they partly stand in for the two indirect
    // proxies. Both proxies under-read specialist venues: relevance rank misses
    // journals buried deep in a broad result set (Brain and Language came back
    // at rank 72 for an aphasia paper), and field share penalises journals whose
    // output is mostly outside the indexed topics — Brain and Language reads as
    // 4% in-field only because most of what it publishes is not imaging.
    let fit;
    if (citeAff.size) {
      const simE = Math.max(simN, 0.60 * cite);
      const specE = Math.max(spec, 0.60 * cite);
      fit = 0.38 * simE + 0.13 * volN + 0.06 * breadth + 0.18 * specE + 0.25 * cite;
    } else {
      fit = 0.45 * simN + 0.20 * volN + 0.12 * breadth + 0.23 * spec;
    }

    const papers = [...v.papers.values()]
      .sort((a, b) => (b.probes.size - a.probes.size) || (b.score - a.score) ||
                      ((b.year || 0) - (a.year || 0)))
      .slice(0, 5)
      .map((p) => ({ ...p, facets: p.probes.size, probes: undefined }));

    const isJournal = rec
      ? rec.kind === 'journal' && !rec.is_preprint_repository
      : !NON_JOURNAL.test(v.title);

    results.push({
      id: rec?.id || v.key,
      name: rec?.display_name || v.title,
      altNames: rec?.alternate_titles || [],
      publisher: rec?.publisher || null,
      homepage: rec?.homepage_url || null,
      issns: rec?.issn || (v.issn ? [v.issn] : []),
      issn_l: rec?.issn_l || v.issn || null,
      type: rec?.type || null,
      inCatalog: !!rec,
      isJournal,
      isPreprint: !!rec?.is_preprint_repository,
      isOa: !!rec?.is_oa,
      inDoaj: !!rec?.is_in_doaj,
      isCore: !!rec?.is_core,
      apcUsd: rec?.apc_usd ?? null,
      apcKnown: rec?.apc_known ?? false,
      apcSource: rec?.apc_source ? rec.apc_source.toUpperCase() : null,
      apcUrl: rec?.doaj_apc_url || null,
      apcNative: rec && rec.apc_amount != null && rec.apc_currency
        ? { price: rec.apc_amount, currency: rec.apc_currency } : null,
      oaModel: rec?.oa_model || 'unknown',
      worksCount: rec?.works_count || 0,
      hIndex: rec?.h_index ?? null,
      citedness: rec?.two_yr_mean_citedness ?? null,

      fit: +fit.toFixed(4),
      simScore: +v.sim.toFixed(3),
      simNorm: +simN.toFixed(3),
      matchCount: v.hits,
      topicWorks: rec?.fieldWorks || 0,
      fieldShare: rec?.fieldShare ?? null,
      perField: rec?.perField || null,
      citedCount,
      probesMatched: [...v.labels],
      samplePapers: papers,
      journalTopics: (rec?.topics || []).slice(0, 8).map((t) => ({
        id: t.id, name: t.name, count: t.count,
      })),
    });
  }

  results.sort((a, b) => b.fit - a.fit);

  return {
    query: { title, abstract, sinceYear: config.sinceYear },
    keywords: kw,
    fields: detected,
    catalogSize: catalog?.size || 0,
    catalogFields: catalog?.fields || [],
    catalogGenerated: catalog?.generated || null,
    probes: runs.map((r) => ({
      label: r.q.label, query: r.q.query,
      total: r.data.hitCount ?? 0, returned: (r.data.resultList?.result || []).length,
    })),
    probeErrors: errors,
    topics: (detected.matched[0]?.field?.name
      ? detected.matched.map((m) => ({ id: m.field.id, name: m.field.name }))
      : []),
    citations: {
      used: citeAff.size > 0,
      journalsMatched: cited.byId.size,
      citationsMatched: cited.total,
      referencesGiven: cited.refCount,
      top: [...cited.byId.values()]
        .sort((a, b) => b.count - a.count).slice(0, 8)
        .map((v) => ({ name: v.journal.display_name, count: v.count })),
    },
    worksExamined: seenWorks.size,
    venuesConsidered: venues.size,
    journals: results,
  };
}
