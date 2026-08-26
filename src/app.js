/**
 * app.js — UI wiring for Journal Picker.
 *
 * Holds the last recommendation in memory so filter changes re-render instantly
 * without re-querying the API.
 */

import { recommend, config } from './engine.js';
import { loadCatalogs, catalogManifest } from './catalog.js';

const $ = (id) => document.getElementById(id);
const el = {
  title: $('title'), abstract: $('abstract'), absCount: $('absCount'),
  goBtn: $('goBtn'), demoBtn: $('demoBtn'), status: $('status'),
  filterPanel: $('filterPanel'), results: $('results'), evidence: $('evidence'), empty: $('empty'),
  apcSlider: $('apcSlider'), apcOut: $('apcOut'), citeSlider: $('citeSlider'), citeOut: $('citeOut'),
  doajOnly: $('doajOnly'), coreOnly: $('coreOnly'), hidePreprint: $('hidePreprint'),
  agreeFile: $('agreeFile'), agreeBtn: $('agreeBtn'), agreeStatus: $('agreeStatus'),
  agreeOnly: $('agreeOnly'), agreeOnlyWrap: $('agreeOnlyWrap'), dropZone: $('dropZone'),
  refs: $('refs'), refBox: $('refBox'), refStat: $('refStat'),
  themeBtn: $('themeBtn'), cardTpl: $('cardTpl'),
  modeMatch: $('modeMatch'), modeBrowse: $('modeBrowse'),
  matchPanel: $('matchPanel'), browsePanel: $('browsePanel'),
  browseQ: $('browseQ'), browseCount: $('browseCount'),
  browseField: $('browseField'),
};

let mode = 'match';        // 'match' | 'browse'
let browseAll = null;      // catalog journals mapped into result shape
let browseFieldId = null;  // which field's catalog browse is showing
let lastRun = null;        // full engine output
let agreementIndex = null; // parsed institutional agreements
let agreementsMod = null;  // lazily-imported parser module

/* ================================================================== *
 * Cost model
 *
 * The key distinction most tools get wrong: "free" is not the same as
 * "open access". A subscription journal costs nothing to publish in but
 * puts your paper behind a paywall. A gold OA journal is open but charges
 * an APC. Only diamond OA — or an institutional agreement — gives you both.
 * ================================================================== */

function costModel(j) {
  const covered = j._agreement || null;
  const apc = j.apcUsd;

  if (covered) {
    return {
      oaCost: 0, minCost: 0, oaPossible: true, oaFree: true,
      amount: '$0', label: 'covered by your agreement', cls: 'free',
    };
  }
  const attribution = j.apcSource ? ` (per ${j.apcSource})` : '';
  const money = (n) => `$${Number(n).toLocaleString()}`;

  // A journal can be flagged open access with no price on record. That is
  // "unknown", never "free" — budgeting around an unverified number is exactly
  // the mistake this tool exists to prevent.
  if ((j.oaModel === 'gold' || j.oaModel === 'hybrid') && apc == null) {
    return { oaCost: null, minCost: j.oaModel === 'hybrid' ? 0 : null,
      oaPossible: true, oaFree: false,
      amount: 'APC n/a', label: 'open access, price not published', cls: 'unknown' };
  }
  if (j.oaModel === 'unknown' || !j.inCatalog) {
    return { oaCost: null, minCost: null, oaPossible: false, oaFree: false,
      amount: '—', label: 'not in our journal catalog', cls: 'unknown' };
  }

  switch (j.oaModel) {
    case 'diamond':
      return { oaCost: 0, minCost: 0, oaPossible: true, oaFree: true,
        amount: '$0', label: `diamond OA — no charge${attribution}`, cls: 'free' };
    case 'gold':
      return { oaCost: apc, minCost: apc, oaPossible: true, oaFree: apc === 0,
        amount: money(apc), label: `APC — open access${attribution}`, cls: '' };
    case 'oa-apc-unknown':
      // Unknown is not free. Treat it as unaffordable under a cap so nobody
      // budgets around a price we could not actually verify.
      return { oaCost: null, minCost: null, oaPossible: true, oaFree: false,
        amount: 'APC n/a', label: 'open access, price not published', cls: 'unknown' };
    case 'hybrid':
      return { oaCost: apc, minCost: 0, oaPossible: true, oaFree: false,
        amount: money(apc), label: 'optional OA fee · $0 paywalled', cls: '' };
    default:
      return { oaCost: null, minCost: 0, oaPossible: false, oaFree: false,
        amount: '$0', label: 'free to publish · paywalled', cls: 'free' };
  }
}

/** The cost that actually matters given what the author asked for. */
function costForRoute(cm, route) {
  if (route === 'oa' || route === 'freeoa') return cm.oaCost;
  if (route === 'free') return cm.minCost;
  // 'any': cheapest way to get published at all
  return cm.minCost;
}

/* ================================================================== *
 * Filtering
 * ================================================================== */

const sliderApc = () => {
  const v = +el.apcSlider.value;
  return v >= 13 ? Infinity : v * 1000;
};
const currentRoute = () =>
  document.querySelector('input[name="route"]:checked')?.value || 'any';

function passesRoute(cm, route) {
  switch (route) {
    case 'oa':     return cm.oaPossible;
    case 'free':   return cm.minCost === 0;
    case 'freeoa': return cm.oaFree;
    default:       return true;
  }
}

function applyFilters(journals) {
  const cap = sliderApc();
  const route = currentRoute();
  const minCite = +el.citeSlider.value;
  const out = [];

  for (const j of journals) {
    if (el.hidePreprint.checked && !j.isJournal) continue;
    if (el.doajOnly.checked && !j.inDoaj) continue;
    if (el.coreOnly.checked && !j.isCore) continue;
    if (el.agreeOnly.checked && !j._agreement) continue;
    if (minCite > 0 && (j.citedness ?? 0) < minCite) continue;

    const cm = costModel(j);
    if (!passesRoute(cm, route)) continue;

    // Over-budget journals are shown greyed rather than hidden, so authors can
    // see what they are giving up by capping spend.
    const relevant = costForRoute(cm, route);
    const over = cap !== Infinity && relevant != null && relevant > cap;

    out.push({ ...j, _cost: cm, _over: over });
  }
  // In-budget options first, then by fit.
  out.sort((a, b) => (a._over - b._over) || (b.fit - a.fit));
  return out;
}

/* ================================================================== *
 * Rendering
 * ================================================================== */

/** OpenAlex strips apostrophes from source names: "Alzheimer s & Dementia". */
const tidyName = (n) => String(n ?? '').replace(/\b([A-Z][a-z]+) s\b/g, "$1's");

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderEvidence(run) {
    el.evidence.hidden = false;
  // Some queries failing is not the same as none failing: results still render,
  // just from a narrower sweep, and the reader deserves to know.
  const partial = (run.probeErrors && run.probeErrors.length && run.probes.length)
    ? `<p class="caveat"><b>Partial results.</b> ${run.probeErrors.length} of ${
        run.probeErrors.length + run.probes.length} searches were rejected by Europe PMC,
        usually rate limiting. These rankings come from the searches that succeeded —
        run it again in a moment for the full set.</p>`
    : '';
  const missing = run.catalogMissing
    ? `<p class="caveat caveat-bad"><b>Journal catalog unavailable.</b> Results are ranked by
       similarity alone — prices, review times and open-access status are all missing. This
       usually means <code>data/</code> did not deploy. Do not use these figures.</p>`
    : '';
  const caveats = missing + partial + (run.coverageNotes || []).map((c) =>
    `<p class="caveat"><b>${esc(c.field)}:</b> ${esc(c.note)}</p>`).join('');
  el.evidence.innerHTML = `
    <div class="panel-head"><h2>How these were found</h2></div>
    ${caveats}
    <div class="ev-grid">
      <div class="ev-block">
        <h4>Search probes</h4>
        <div class="chips">${run.probes.map((p) =>
          `<span class="chip q" title="${esc(p.total.toLocaleString())} indexed matches">${esc(p.query)}</span>`).join('')}</div>
      </div>
      ${(run.fields?.matched || []).filter((m) => m.field.coverage_note).map((m) => `
      <div class="ev-block ev-warn">
        <h4>⚠ Coverage caveat — ${esc(m.field.name)}</h4>
        <p class="ev-note">${esc(m.field.coverage_note)}</p>
      </div>`).join('')}
      <div class="ev-block">
        <h4>Detected field</h4>
        <div class="chips">${run.topics.map((t) => `<span class="chip">${esc(t.name)}</span>`).join('')
          || '<span class="chip">no field lexicon matched</span>'}</div>
      </div>
      <div class="ev-block">
        <h4>Methods &amp; population detected</h4>
        <div class="chips">${[...(run.fields?.methods || []).slice(0, 5),
                             ...(run.fields?.populations || []).slice(0, 5)]
          .map((m) => `<span class="chip">${esc(m)}</span>`).join('') || '<span class="chip">none recognised</span>'}</div>
      </div>
      ${run.citations?.used ? `
      <div class="ev-block">
        <h4>Journals you cite</h4>
        <div class="chips">${run.citations.top.map((t) =>
          `<span class="chip">${esc(tidyName(t.name))} ×${t.count}</span>`).join('')}</div>
      </div>` : ''}
      <div class="ev-block">
        <h4>Evidence base</h4>
        <div class="ev-stats">
          <div class="ev-stat"><b>${run.worksExamined.toLocaleString()}</b><span>similar papers read</span></div>
          <div class="ev-stat"><b>${run.venuesConsidered.toLocaleString()}</b><span>venues seen</span></div>
          <div class="ev-stat"><b>${(run.catalogSize || 0).toLocaleString()}</b><span>journals in catalog</span></div>
        </div>
      </div>
    </div>`;
}

function badgesFor(j) {
  const b = [];
  if (j._agreement) {
    const pub = j._agreement.publisher ? ` · ${j._agreement.publisher}` : '';
    b.push(['b-cover', `✓ Covered by your agreement${pub}`]);
  }
  const oaLabel = {
    diamond: '◆ Diamond OA — free to publish, free to read',
    gold: 'Fully open access',
    'oa-apc-unknown': 'Open access · price unverified',
    unknown: 'Not in catalog',
    hybrid: 'Hybrid — OA optional',
    subscription: 'Subscription',
  }[j.oaModel];
  if (oaLabel) {
    // b-cover is reserved for agreement coverage — it is the one badge that
    // means "this costs you nothing", so nothing else may share its colour.
    const cls = j.oaModel === 'diamond' ? 'b-diamond'
      : j.oaModel === 'subscription' ? 'b-plain'
      : j.oaModel === 'oa-apc-unknown' ? 'b-warn' : 'b-oa';
    b.push([cls, oaLabel]);
  }
  if (j.citedCount) {
    b.push(['b-cite', `You cite this journal ${j.citedCount}×`]);
  }
  if (j.review) {
    const d = j.review.median;
    if (j.review.suspect) {
      // Implausibly fast: commissioned content, or a publisher depositing the
      // revision date as "received". Say that rather than print the number.
      b.push(['b-warn', 'review dates look unreliable']);
    } else {
      // Buckets are generous: what authors care about is fast/typical/slow, and
      // the underlying medians carry real sampling noise.
      const cls = d <= 60 ? 'b-fast' : d <= 120 ? 'b-oa' : d <= 200 ? 'b-plain' : 'b-slow';
      b.push([cls, `~${d}d in review (n=${j.review.n})`]);
    }
  }
  // Independent listings, stated as facts.
  //
  // Deliberately NOT a predatory-risk score. The obvious heuristic — charges an
  // APC, absent from DOAJ, few citations — overwhelmingly flags legitimate
  // regional and non-English journals: Neurología Argentina, Revista Colombiana
  // de Psiquiatría, Die Radiologie all trip it. Such a score would defame real
  // society journals and be biased against non-English scholarship, so we show
  // what can be verified and let the author judge.
  if (j.inDoaj) b.push(['b-plain', '✓ listed in DOAJ']);
  if (j.isCore) b.push(['b-plain', '✓ established venue']);
  if (!j.inDoaj && !j.isCore && j.inCatalog) {
    b.push(['b-warn', 'no DOAJ or established-venue listing']);
  }
  if (!j.isJournal) b.push(['b-warn', j.isPreprint ? 'Preprint server' : 'Repository — not a journal']);
  return b;
}

function whyText(j) {
  const bits = [];
  if (j.fit == null) {
    // Browse mode: describe the journal, don't imply a match we never computed.
    if (j.topicWorks) bits.push(`<b>${j.topicWorks.toLocaleString()}</b> papers in this field`);
    if (j.fieldShare != null) bits.push(`<b>${Math.round(j.fieldShare * 100)}%</b> of its output`);
    if (j.worksCount) bits.push(`${j.worksCount.toLocaleString()} papers total`);
    return bits.join(' · ') || 'In the catalog.';
  }
  if (j.matchCount) {
    bits.push(`published <b>${j.matchCount}</b> paper${j.matchCount === 1 ? '' : 's'} closely matching yours`);
  }
  if (j.topicWorks) {
    bits.push(`<b>${j.topicWorks.toLocaleString()}</b> recent papers in your topic area`);
  }
  if (j.probesMatched.length > 2) {
    bits.push(`matched <b>${j.probesMatched.length}</b> different facets of your abstract`);
  }
  if (j.review && !j.review.suspect && j.review.median <= 60) {
    bits.push(`fast review — median <b>${j.review.median}</b> days`);
  }
  if (j.citedCount >= 2) {
    bits.push(`you cite it <b>${j.citedCount}</b> times`);
  }
  if (j.fieldShare != null && j.fieldShare >= 0.15) {
    bits.push(`<b>${Math.round(j.fieldShare * 100)}%</b> of what it publishes is in your field`);
  } else if (j.fieldShare != null && j.fieldShare < 0.04 && j.worksCount > 50000) {
    bits.push(`a general-interest megajournal — only <b>${(j.fieldShare * 100).toFixed(1)}%</b> in your field`);
  }
  return bits.length ? bits.join(' · ') : 'Publishes in your topic area.';
}

function renderCards(list) {
  const frag = document.createDocumentFragment();

  for (const j of list) {
    const node = el.cardTpl.content.cloneNode(true);
    const card = node.querySelector('.card');
    if (j._over) card.classList.add('over-budget');
    if (j._agreement) card.classList.add('covered');

    // Fit ring — only meaningful when we matched against a manuscript.
    if (j.fit == null) {
      node.querySelector('.fitwrap').remove();
    } else {
      const pct = Math.round(j.fit * 100);
      const ring = node.querySelector('.ring-fg');
      const circ = 2 * Math.PI * 18;
      ring.style.strokeDasharray = `${circ}`;
      ring.style.strokeDashoffset = `${circ * (1 - Math.min(pct, 100) / 100)}`;
      node.querySelector('.fitnum').textContent = pct;
    }

    // title + meta
    const link = node.querySelector('.jname');
    link.textContent = tidyName(j.name);
    link.href = j.homepage || `https://openalex.org/${j.id}`;
    const metaBits = [j.publisher, j.issn_l].filter(Boolean);
    node.querySelector('.jmeta').innerHTML = esc(metaBits.join(' · ')) +
      (j.citedness != null
        ? ` · <b class="metric" title="Mean citations to the previous two years' articles, from OpenAlex. Comparable to a Journal Impact Factor but computed on open data — it is not Clarivate's JIF.">impact ${j.citedness}</b>`
        : '') +
      (j.hIndex != null
        ? ` · <span class="metric-dim" title="h-index: the journal has ${j.hIndex} papers cited at least ${j.hIndex} times each, over its whole lifetime. It rewards age and size, so it is not an impact factor and is a poor way to compare a new journal with an old one.">h-index ${j.hIndex}</span>`
        : '') +
      (j.worksCount ? ` · ${j.worksCount.toLocaleString()} papers` : '');

    // cost
    const amt = node.querySelector('.cost-amount');
    amt.textContent = j._cost.amount;
    if (j._cost.cls) amt.classList.add(j._cost.cls);
    node.querySelector('.cost-label').textContent =
      j._over ? `over your cap · ${j._cost.label}` : j._cost.label;

    // badges
    const bwrap = node.querySelector('.badges');
    for (const [cls, text] of badgesFor(j)) {
      const s = document.createElement('span');
      s.className = `badge ${cls}`;
      s.innerHTML = text;
      bwrap.appendChild(s);
    }

    // why
    node.querySelector('.why-bars').innerHTML = `
      ${j.fit == null ? '' : `<span class="wb">similarity <i><b style="width:${
        Math.round(j.simNorm * 100)}%"></b></i></span>`}
      <span class="wb">topic volume <i><b style="width:${Math.round(Math.min(j.topicWorks / 2500, 1) * 100)}%"></b></i></span>
      ${j.fieldShare != null ? `<span class="wb">specialisation <i><b style="width:${
        Math.round(Math.min(j.fieldShare / 0.25, 1) * 100)}%"></b></i></span>` : ''}`;
    node.querySelector('.why-text').innerHTML = whyText(j);

    // sample papers
    const papers = node.querySelector('.papers');
    if (j.samplePapers.length) {
      papers.querySelector('.papers-n').textContent =
        `See ${j.samplePapers.length} similar paper${j.samplePapers.length === 1 ? '' : 's'} they published`;
      const ul = papers.querySelector('.paper-list');
      for (const p of j.samplePapers) {
        const li = document.createElement('li');
        const a = p.doi
          ? `<a href="${esc(p.doi)}" target="_blank" rel="noopener">${esc(p.title)}</a>`
          : esc(p.title);
        li.innerHTML = `${a} <span class="py">(${p.year ?? 'n.d.'}${p.cites ? `, ${p.cites} cites` : ''})</span>`;
        ul.appendChild(li);
      }
      if (j.review) {
        const r = j.review;
        const li = document.createElement('li');
        li.className = 'review-detail';
        li.innerHTML = r.suspect
          ? `<b>Peer review:</b> the deposited dates give a median of only ${r.median} days ` +
            `(n=${r.n}), which is too fast for external review of a research paper. This journal ` +
            `likely publishes commissioned content, or records the revision date as submission. ` +
            `<span class="src">Treat as unknown.</span>`
          : `<b>Peer review:</b> median ${r.median} days from submission to acceptance ` +
          `(middle half ${r.p25}–${r.p75} days, n=${r.n} research articles)` +
          (r.to_pub ? `, then ~${r.to_pub} days to appear` : '') +
          `. <span class="src">From publisher-deposited dates in PubMed.</span>`;
        papers.querySelector('.paper-list').prepend(li);
      }
      if (j.journalTopics.length) {
        papers.querySelector('.jtopics').textContent =
          `Journal's main topics: ${j.journalTopics.slice(0, 5).map((t) => t.name).join(' · ')}`;
      }
    } else {
      papers.remove();
    }

    frag.appendChild(node);
  }
  return frag;
}

function render() {
  if (mode === 'browse') { renderBrowse(); return; }
  if (!lastRun) return;
  attachAgreements(lastRun.journals);
  const list = sortResults(applyFilters(lastRun.journals), sortPrimary, sortSecondary);

  el.results.hidden = false;
  el.results.innerHTML = '';

  const inBudget = list.filter((j) => !j._over).length;
  const head = document.createElement('div');
  head.className = 'res-head';
  head.innerHTML = `
    <div class="res-head-left">
      <h2>Recommended journals</h2>
      <span class="res-count">${inBudget} match your criteria${
        list.length - inBudget ? ` · ${list.length - inBudget} shown but over your cap` : ''}</span>
      <div class="fchips">${activeFilterChips()}</div>
    </div>
    ${sortBarHtml()}`;
  el.results.appendChild(head);
  wireSortBar(render);
  wireFilterChips(render);
  flashCount();

  if (!list.length) {
    el.empty.hidden = false;
    el.empty.innerHTML = `<h2>Nothing matches those constraints</h2>
      <p>Try raising the price ceiling, or loosening the publishing route — for example,
      "free for me" excludes every gold open-access journal by definition.</p>`;
    return;
  }
  el.empty.hidden = true;
  el.results.appendChild(renderCards(list.slice(0, 60)));
}

/* ================================================================== *
 * Institutional agreements
 * ================================================================== */

function attachAgreements(journals) {
  for (const j of journals) {
    j._agreement = null;
    if (!agreementIndex || !agreementsMod) continue;
    j._agreement = agreementsMod.lookupAgreement(agreementIndex, {
      issns: j.issns || [],
      title: j.name,
    });
  }
}

async function loadAgreementFiles(files) {
  if (!files?.length) return;
  el.agreeStatus.innerHTML = '<span class="spin"></span>Parsing…';
  try {
    agreementsMod ||= await import('./agreements.js');
    const parsed = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      parsed.push(await agreementsMod.parseAgreementFile(buf, f.name));
    }
    agreementIndex = agreementsMod.buildAgreementIndex(parsed);
    const pubs = agreementIndex.publishers || [];
    el.agreeStatus.innerHTML =
      `<span class="ok">✓ ${agreementIndex.count.toLocaleString()} covered journals loaded</span>` +
      `<span class="pubs">${pubs.length} publisher list${pubs.length === 1 ? '' : 's'}: ${
        esc(pubs.slice(0, 6).join(', '))}${pubs.length > 6 ? `, +${pubs.length - 6} more` : ''}</span>`;
    el.agreeOnlyWrap.hidden = false;
    render();
  } catch (err) {
    console.error(err);
    el.agreeStatus.innerHTML = `<span class="bad">Could not read that file: ${esc(err.message)}</span>`;
  }
}

/* ================================================================== *
 * Browse mode
 *
 * The whole catalog, no abstract required. Same cards and same cost model as
 * the match view, minus the per-manuscript similarity evidence — so "show me
 * everything I can publish in for free" is one click rather than a search.
 * ================================================================== */

/** Map a raw catalog record into the shape the card renderer expects. */
function catalogToResult(rec) {
  return {
    id: rec.id,
    name: rec.display_name,
    altNames: rec.alternate_titles || [],
    publisher: rec.publisher || null,
    homepage: rec.homepage_url || null,
    issns: rec.issn || (rec.issn_l ? [rec.issn_l] : []),
    issn_l: rec.issn_l || null,
    type: rec.type || null,
    inCatalog: true,
    isJournal: rec.kind === 'journal' && !rec.is_preprint_repository,
    isPreprint: !!rec.is_preprint_repository,
    isOa: !!rec.is_oa,
    inDoaj: !!rec.is_in_doaj,
    isCore: !!rec.is_core,
    apcUsd: rec.apc_usd ?? null,
    apcKnown: rec.apc_known ?? false,
    apcSource: rec.apc_source ? rec.apc_source.toUpperCase() : null,
    apcUrl: rec.doaj_apc_url || null,
    apcNative: rec.apc_amount != null && rec.apc_currency
      ? { price: rec.apc_amount, currency: rec.apc_currency } : null,
    oaModel: rec.oa_model || 'unknown',
    worksCount: rec.works_count || 0,
    hIndex: rec.h_index ?? null,
    citedness: rec.two_yr_mean_citedness ?? null,
    // no manuscript to compare against in browse mode
    fit: null,
    simNorm: 0,
    matchCount: 0,
    review: rec.review || null,
    topicWorks: rec.fieldWorks ?? rec.neuro_works ?? 0,
    fieldShare: rec.fieldShare ?? rec.neuro_share ?? null,
    probesMatched: [],
    samplePapers: [],
    journalTopics: (rec.topics || []).slice(0, 8).map((t) => ({
      id: t.id, name: t.name, count: t.count,
    })),
  };
}

/**
 * Populate the field selector from the manifest. One catalog is loaded at a
 * time on purpose: across every field the catalogs come to tens of megabytes,
 * and nobody browsing "free dental journals" needs the genetics catalog.
 */
async function ensureFieldOptions() {
  if (el.browseField.options.length) return;
  const manifest = await catalogManifest(config.dataBase);
  el.browseField.innerHTML = manifest.map((f) => {
    const n = f.submittable ?? f.journals;
    return `<option value="${esc(f.id)}">${esc(f.name)}${
      n ? ` — ${n.toLocaleString()} journals` : ''}</option>`;
  }).join('');
  // Prefer the field the author last looked at.
  let want = null;
  try { want = localStorage.getItem('jp-browse-field'); } catch {}
  if (want && manifest.some((f) => f.id === want)) el.browseField.value = want;
  browseFieldId = el.browseField.value || manifest[0]?.id || null;
}

async function ensureBrowse() {
  await ensureFieldOptions();
  const want = el.browseField.value || browseFieldId;
  if (browseAll && browseFieldId === want) return browseAll;

  el.browseCount.textContent = 'Loading catalog…';
  const cat = await loadCatalogs([want], config.dataBase);
  if (!cat) {
    el.browseCount.textContent =
      `No catalog for that field yet. Run FIELD=${want} python3 scripts/build-catalog.py to build it.`;
    browseAll = null;
    return null;
  }
  browseFieldId = want;
  try { localStorage.setItem('jp-browse-field', want); } catch {}
  browseAll = cat.journals.map(catalogToResult);
  return browseAll;
}

/** Quick-pick presets drive the existing filter controls, so one code path. */
function applyPreset(preset) {
  const setRoute = (v) => {
    const r = document.querySelector(`input[name="route"][value="${v}"]`);
    if (r) r.checked = true;
  };
  const setApc = (v) => {
    el.apcSlider.value = String(v);
    el.apcOut.textContent = v >= 13 ? 'no limit' : `$${(v * 1000).toLocaleString()}`;
  };
  el.agreeOnly.checked = false;

  switch (preset) {
    case 'diamond': setRoute('freeoa'); setApc(13); break;
    case 'free':    setRoute('free');   setApc(13); break;
    case 'cheap':   setRoute('oa');     setApc(2); break;   // <= $2k band
    case 'covered': setRoute('any');    setApc(13); el.agreeOnly.checked = true; break;
    default:        setRoute('any');    setApc(13); break;
  }
  document.querySelectorAll('.qp').forEach((b) =>
    b.classList.toggle('is-on', b.dataset.preset === preset));
}

/**
 * Sort options shared by both modes.
 *
 * "Impact" is OpenAlex's 2-year mean citedness — citations received by the
 * previous two years' articles. That is the same calculation as the Journal
 * Impact Factor, but computed on open data. It is deliberately NOT called a
 * Journal Impact Factor: JIF is Clarivate's trademarked metric computed on Web
 * of Science, the numbers differ, and claiming otherwise would be wrong.
 */
export const SORTS = {
  fit:     { label: 'Best match',              cmp: (a, b) => (b.fit ?? -1) - (a.fit ?? -1) },
  cheap:   { label: 'Cheapest to publish',     cmp: (a, b) => costKey(a) - costKey(b) },
  apc:     { label: 'Lowest open-access fee',  cmp: (a, b) => oaKey(a) - oaKey(b) },
  fast:    { label: 'Fastest review',          cmp: (a, b) => reviewKey(a) - reviewKey(b) },
  impact:  { label: 'Highest impact (2yr)',    cmp: (a, b) => (b.citedness ?? -1) - (a.citedness ?? -1) },
  hindex:  { label: 'Highest h-index (lifetime)', cmp: (a, b) => (b.hIndex ?? -1) - (a.hIndex ?? -1) },
  share:   { label: 'Most specialised',        cmp: (a, b) => (b.fieldShare ?? -1) - (a.fieldShare ?? -1) },
  volume:  { label: 'Most papers in my field', cmp: (a, b) => (b.topicWorks ?? 0) - (a.topicWorks ?? 0) },
  cited:   { label: 'Journals I cite most',    cmp: (a, b) => (b.citedCount ?? 0) - (a.citedCount ?? 0) },
  covered: { label: 'My university covers it', cmp: (a, b) => (b._agreement ? 1 : 0) - (a._agreement ? 1 : 0) },
  name:    { label: 'Name (A\u2013Z)',           cmp: (a, b) => a.name.localeCompare(b.name) },
};

const num = (v) => (v == null ? Infinity : v);

/**
 * "Cheapest" must sort by the number printed on the card.
 *
 * Sorting on minCost is defensible — a hybrid journal costs nothing if you
 * accept a paywall — but the card shows that journal's open-access fee, so the
 * list rendered $4,200 above $0 and read as broken. Sorting on a figure the
 * reader cannot see is a bug whatever the logic behind it. Use the displayed
 * amount here; "Lowest open-access fee" covers the other question.
 */
const costKey = (j) => {
  const c = j._cost;
  if (!c) return Infinity;
  if (c.minCost === 0 && (c.oaCost === 0 || c.oaCost == null)) return 0;  // free / covered
  if (c.oaCost != null) return c.oaCost;                                   // gold or hybrid: shown fee
  return num(c.minCost);
};
const oaKey = (j) => (j._cost ? num(j._cost.oaCost) : Infinity);
// Unreliable medians must not win a "fastest review" sort.
const reviewKey = (j) => (j.review && !j.review.suspect ? j.review.median : Infinity);

/** Sort by a primary key, breaking ties with a secondary one. */
export function sortResults(list, primary, secondary) {
  const p = SORTS[primary] || SORTS.fit;
  const sec = secondary && secondary !== primary ? SORTS[secondary] : null;
  return list.sort((a, b) => {
    const r = p.cmp(a, b);
    if (r !== 0) return r;
    return sec ? sec.cmp(a, b) : (b.fit ?? 0) - (a.fit ?? 0);
  });
}

let sortPrimary = 'fit';
let sortSecondary = '';
try {
  sortPrimary = localStorage.getItem('jp-sort1') || 'fit';
  sortSecondary = localStorage.getItem('jp-sort2') || '';
} catch {}

/**
 * A chip per active constraint, above the results.
 *
 * Without this the only feedback was a count, so a filter that legitimately
 * changes nothing — an APC cap when every remaining journal is already covered
 * at $0 — was indistinguishable from a filter that did not work. Showing what
 * is applied, and letting each chip be clicked off, makes the state legible.
 */
function activeFilterChips() {
  const chips = [];
  const cap = sliderApc();
  if (cap !== Infinity) chips.push(['apc', `under $${cap.toLocaleString()}`]);

  const route = currentRoute();
  const routeLabel = { oa: 'open access only', free: 'free for me',
                       freeoa: 'free and open access' }[route];
  if (routeLabel) chips.push(['route', routeLabel]);

  if (el.agreeOnly.checked) chips.push(['agree', 'my institution covers it']);
  if (el.doajOnly.checked) chips.push(['doaj', 'in DOAJ']);
  if (el.coreOnly.checked) chips.push(['core', 'well-established venue']);
  const mc = +el.citeSlider.value;
  if (mc > 0) chips.push(['cite', `impact \u2265 ${mc}`]);
  if (!el.hidePreprint.checked) chips.push(['pre', 'including preprint servers']);

  if (!chips.length) return '<span class="chip-none">no filters applied</span>';
  return chips.map(([k, label]) =>
    `<button class="fchip" data-clear="${k}" title="Click to remove">${esc(label)} <b>\u00d7</b></button>`
  ).join('');
}

/** Let a chip switch its own filter back off. */
function wireFilterChips(rerender) {
  document.querySelectorAll('.fchip').forEach((btn) => {
    btn.addEventListener('click', () => {
      switch (btn.dataset.clear) {
        case 'apc':   el.apcSlider.value = '13'; el.apcOut.textContent = 'no limit'; break;
        case 'route': document.querySelector('input[name="route"][value="any"]').checked = true; break;
        case 'agree': el.agreeOnly.checked = false; break;
        case 'doaj':  el.doajOnly.checked = false; break;
        case 'core':  el.coreOnly.checked = false; break;
        case 'cite':  el.citeSlider.value = '0'; el.citeOut.textContent = 'any'; break;
        case 'pre':   el.hidePreprint.checked = true; break;
      }
      rerender();
    });
  });
}

/** Briefly highlight the count so a change registers even when it is a no-op. */
function flashCount() {
  const n = el.results.querySelector('.res-count');
  if (!n) return;
  n.classList.remove('flash');
  void n.offsetWidth;          // restart the animation
  n.classList.add('flash');
}

/** The sort bar shown above results in both modes. */
function sortBarHtml() {
  const opts = (sel) => Object.entries(SORTS)
    .map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v.label}</option>`)
    .join('');
  return `<div class="sortbar">
    <label>Sort <select id="sort1">${opts(sortPrimary)}</select></label>
    <label>then by <select id="sort2">
      <option value=""${sortSecondary ? '' : ' selected'}>\u2014</option>
      ${opts(sortSecondary)}</select></label>
  </div>`;
}

function wireSortBar(rerender) {
  const s1 = $('sort1'); const s2 = $('sort2');
  if (!s1) return;
  s1.addEventListener('change', () => {
    sortPrimary = s1.value;
    try { localStorage.setItem('jp-sort1', sortPrimary); } catch {}
    rerender();
  });
  s2.addEventListener('change', () => {
    sortSecondary = s2.value;
    try { localStorage.setItem('jp-sort2', sortSecondary); } catch {}
    rerender();
  });
}

function sortBrowse(list) {
  return sortResults(list, sortPrimary === 'fit' ? 'volume' : sortPrimary, sortSecondary);
}


async function renderBrowse() {
  const all = await ensureBrowse();
  if (!all) return;

  const q = el.browseQ.value.trim().toLowerCase();
  let list = all;
  if (q) {
    list = list.filter((j) =>
      j.name.toLowerCase().includes(q) ||
      (j.publisher || '').toLowerCase().includes(q) ||
      j.altNames.some((n) => n.toLowerCase().includes(q)) ||
      j.journalTopics.some((t) => t.name.toLowerCase().includes(q)));
  }

  attachAgreements(list);
  list = sortBrowse(applyFilters(list));

  const inBudget = list.filter((j) => !j._over);
  const fieldLabel = el.browseField.selectedOptions[0]?.textContent?.split(' — ')[0] || '';
  el.browseCount.textContent =
    `${inBudget.length.toLocaleString()} of ${all.length.toLocaleString()} ${fieldLabel} journals match` +
    (list.length - inBudget.length ? ` · ${list.length - inBudget.length} over your cap` : '');

  el.results.hidden = false;
  el.results.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'res-head';
  head.innerHTML = `
    <div class="res-head-left">
      <h2>Journals</h2>
      <span class="res-count">showing ${Math.min(inBudget.length, 100).toLocaleString()} of ${
        inBudget.length.toLocaleString()}</span>
      <div class="fchips">${activeFilterChips()}</div>
    </div>
    ${sortBarHtml()}`;
  el.results.appendChild(head);
  wireSortBar(renderBrowse);
  wireFilterChips(renderBrowse);
  flashCount();

  if (!list.length) {
    el.empty.hidden = false;
    el.empty.innerHTML = `<h2>Nothing matches those constraints</h2>
      <p>Try "Show everything", or raise the price ceiling.</p>`;
    return;
  }
  el.empty.hidden = true;
  el.results.appendChild(renderCards(inBudget.slice(0, 100)));
}

function setMode(next) {
  mode = next;
  const browsing = next === 'browse';
  el.modeBrowse.classList.toggle('is-on', browsing);
  el.modeMatch.classList.toggle('is-on', !browsing);
  el.modeBrowse.setAttribute('aria-selected', String(browsing));
  el.modeMatch.setAttribute('aria-selected', String(!browsing));
  el.browsePanel.hidden = !browsing;
  el.matchPanel.hidden = browsing;
  el.evidence.hidden = browsing || !lastRun;
  el.filterPanel.hidden = browsing ? false : !lastRun;

  if (browsing) {
    renderBrowse();
  } else if (lastRun) {
    render();
  } else {
    el.results.hidden = true;
    el.empty.hidden = true;
  }
}

el.modeMatch.addEventListener('click', () => setMode('match'));
el.modeBrowse.addEventListener('click', () => setMode('browse'));
el.browseField.addEventListener('change', () => {
  browseAll = null;          // different field, different catalog
  renderBrowse();
});
let browseDebounce;
el.browseQ.addEventListener('input', () => {
  clearTimeout(browseDebounce);
  browseDebounce = setTimeout(() => renderBrowse(), 180);
});
document.querySelectorAll('.qp').forEach((b) => b.addEventListener('click', () => {
  applyPreset(b.dataset.preset);
  renderBrowse();
}));

/* ================================================================== *
 * Run
 * ================================================================== */

async function run() {
  const title = el.title.value.trim();
  const abstract = el.abstract.value.trim();
  if ((title + abstract).length < 40) {
    el.status.textContent = 'Paste a title and abstract first.';
    el.status.classList.add('err');
    return;
  }
  el.status.classList.remove('err');
  el.goBtn.disabled = true;
  el.status.innerHTML = '<span class="spin"></span>Reading the literature…';

  try {
    const out = await recommend({ title, abstract, references: el.refs.value }, {
      onProgress: (stage, d) => {
        const msg = {
          probes: 'Building search probes…',
          retrieved: `Found ${d.works ?? ''} similar papers…`,
          topics: 'Measuring what each journal publishes…',
          fields: 'Detecting research field…',
          citations: 'Reading your reference list…',
        }[stage];
        if (msg) el.status.innerHTML = `<span class="spin"></span>${msg}`;
      },
    });
    lastRun = out;
    el.filterPanel.hidden = false;
    renderEvidence(out);
    render();
    el.status.textContent = `Done — ${out.journals.length} candidate venues ranked.`;
    el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    el.status.textContent = err.message || 'Something went wrong.';
    el.status.classList.add('err');
  } finally {
    el.goBtn.disabled = false;
  }
}

/* ================================================================== *
 * Events
 * ================================================================== */

el.goBtn.addEventListener('click', run);
el.abstract.addEventListener('input', () => {
  const n = el.abstract.value.trim().split(/\s+/).filter(Boolean).length;
  el.absCount.textContent = `${n} word${n === 1 ? '' : 's'}`;
});
el.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

let refDebounce;
el.refs.addEventListener('input', async () => {
  clearTimeout(refDebounce);
  refDebounce = setTimeout(async () => {
    const text = el.refs.value;
    if (!text.trim()) { el.refStat.textContent = ''; return; }
    const [{ buildGazetteer, matchCitations }, { loadCatalogs }] = await Promise.all([
      import('./citations.js'), import('./catalog.js')]);
    const cat = await loadCatalogs([], config.dataBase);
    if (!cat) return;
    const m = matchCitations(text, buildGazetteer(cat));
    el.refStat.innerHTML = m.byId.size
      ? `<span class="ok">Recognised ${m.total} citation${m.total === 1 ? '' : 's'} across ${
          m.byId.size} journal${m.byId.size === 1 ? '' : 's'}</span>` +
        (m.refCount ? ` — from about ${m.refCount} references` : '')
      : 'No journal names recognised yet — paste the full reference list, including journal names.';
  }, 400);
});

el.apcSlider.addEventListener('input', () => {
  const v = sliderApc();
  el.apcOut.textContent = v === Infinity ? 'no limit' : `$${v.toLocaleString()}`;
  render();
});
el.citeSlider.addEventListener('input', () => {
  const v = +el.citeSlider.value;
  el.citeOut.textContent = v === 0 ? 'any' : `≥ ${v}`;
  render();
});
for (const c of [el.doajOnly, el.coreOnly, el.hidePreprint, el.agreeOnly]) {
  c.addEventListener('change', render);
}
document.querySelectorAll('input[name="route"]').forEach((r) =>
  r.addEventListener('change', render));

el.agreeBtn.addEventListener('click', () => el.agreeFile.click());
el.agreeFile.addEventListener('change', (e) => loadAgreementFiles([...e.target.files]));
['dragenter', 'dragover'].forEach((ev) => el.dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); el.dropZone.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => el.dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); el.dropZone.classList.remove('over');
}));
el.dropZone.addEventListener('drop', (e) => loadAgreementFiles([...e.dataTransfer.files]));

el.themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? 'auto' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('jp-theme', next); } catch {}
});
try {
  const saved = localStorage.getItem('jp-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
} catch {}

const fieldsToggle = $('fieldsToggle');
if (fieldsToggle) {
  fieldsToggle.addEventListener('click', (e) => {
    e.preventDefault();
    const list = $('fieldsList');
    list.hidden = !list.hidden;
    fieldsToggle.textContent = list.hidden ? 'See the list' : 'Hide the list';
  });
}

el.demoBtn.addEventListener('click', () => {
  el.title.value = 'Cortical thickness and white matter integrity predict naming recovery after left-hemisphere stroke';
  el.abstract.value = `Anomia is the most common and persistent deficit after left hemisphere stroke. We used structural MRI and diffusion weighted imaging in 84 chronic stroke survivors with aphasia to test whether cortical thickness in spared left temporal cortex and fractional anisotropy of the arcuate fasciculus predict naming performance on the Philadelphia Naming Test. Lesion load was quantified using voxel based lesion symptom mapping. Multivariate regression showed that residual cortical thickness in the posterior middle temporal gyrus and arcuate fasciculus microstructure each explained unique variance in naming accuracy beyond lesion volume alone. These neuroimaging biomarkers may support individualized prognosis and treatment planning in post stroke aphasia rehabilitation.`;
  el.abstract.dispatchEvent(new Event('input'));
  run();
});
