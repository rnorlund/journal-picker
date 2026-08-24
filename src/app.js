/**
 * app.js — UI wiring for Journal Picker.
 *
 * Holds the last recommendation in memory so filter changes re-render instantly
 * without re-querying the API.
 */

import { recommend, config } from './engine.js';
import { loadCatalogs } from './catalog.js';

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
  browseQ: $('browseQ'), browseSort: $('browseSort'), browseCount: $('browseCount'),
};

let mode = 'match';        // 'match' | 'browse'
let browseAll = null;      // catalog journals mapped into result shape
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
  el.evidence.innerHTML = `
    <div class="panel-head"><h2>How these were found</h2></div>
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
    const cls = j.oaModel === 'diamond' ? 'b-cover'
      : j.oaModel === 'subscription' ? 'b-plain'
      : j.oaModel === 'oa-apc-unknown' ? 'b-warn' : 'b-oa';
    b.push([cls, oaLabel]);
  }
  if (j.citedCount) {
    b.push(['b-cite', `You cite this journal ${j.citedCount}×`]);
  }
  if (j.review) {
    const d = j.review.median;
    // Buckets are generous: what authors care about is fast/typical/slow, and
    // the underlying medians carry real sampling noise.
    const cls = d <= 60 ? 'b-cover' : d <= 120 ? 'b-oa' : d <= 200 ? 'b-plain' : 'b-warn';
    b.push([cls, `~${d}d in review (n=${j.review.n})`]);
  }
  if (j.inDoaj) b.push(['b-doaj', 'DOAJ']);
  if (j.isCore) b.push(['b-plain', 'Core venue']);
  if (j.citedness != null) b.push(['b-plain', `${j.citedness} cites/paper (2yr)`]);
  if (j.hIndex != null) b.push(['b-plain', `h-index ${j.hIndex}`]);
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
  if (j.review && j.review.median <= 60) {
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
    const metaBits = [j.publisher, j.issn_l, j.worksCount ? `${j.worksCount.toLocaleString()} papers total` : null]
      .filter(Boolean);
    node.querySelector('.jmeta').textContent = metaBits.join(' · ');

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
        li.innerHTML = `<b>Peer review:</b> median ${r.median} days from submission to acceptance ` +
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
  const list = applyFilters(lastRun.journals);

  el.results.hidden = false;
  el.results.innerHTML = '';

  const inBudget = list.filter((j) => !j._over).length;
  const head = document.createElement('div');
  head.className = 'res-head';
  head.innerHTML = `
    <h2>Recommended journals</h2>
    <span class="res-count">${inBudget} match your criteria${
      list.length - inBudget ? ` · ${list.length - inBudget} shown but over your cap` : ''}</span>`;
  el.results.appendChild(head);

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

async function ensureBrowse() {
  if (browseAll) return browseAll;
  el.browseCount.textContent = 'Loading catalog…';
  const cat = await loadCatalogs([], config.dataBase);  // [] = every catalog
  if (!cat) {
    el.browseCount.textContent =
      'The journal catalog is not available. Run scripts/build-catalog.py to generate data/journals.json.';
    return null;
  }
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

function sortBrowse(list) {
  const key = el.browseSort.value;
  // "Cheapest" needs two keys. Plenty of journals cost nothing to publish in
  // because you accept a paywall, so minCost alone ties every hybrid and
  // subscription venue at $0 — and then shows a $4,200 OA fee on the card,
  // which reads as a bug. Break the tie on the open-access price so genuinely
  // free-and-open journals sort above "free only if you stay paywalled".
  const num = (v) => (v == null ? Infinity : v);
  const minCost = (j) => (j._cost ? num(j._cost.minCost) : Infinity);
  const oaCost = (j) => (j._cost ? num(j._cost.oaCost) : Infinity);
  const cmp = {
    field: (a, b) => b.topicWorks - a.topicWorks,
    cheap: (a, b) => minCost(a) - minCost(b) || oaCost(a) - oaCost(b)
                     || b.topicWorks - a.topicWorks,
    share: (a, b) => (b.fieldShare ?? 0) - (a.fieldShare ?? 0),
    cites: (a, b) => (b.citedness ?? 0) - (a.citedness ?? 0),
    name:  (a, b) => a.name.localeCompare(b.name),
  }[key] || (() => 0);
  return list.sort(cmp);
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
  el.browseCount.textContent =
    `${inBudget.length.toLocaleString()} of ${all.length.toLocaleString()} journals match` +
    (list.length - inBudget.length ? ` · ${list.length - inBudget.length} over your cap` : '');

  el.results.hidden = false;
  el.results.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'res-head';
  head.innerHTML = `<h2>Journals</h2><span class="res-count">showing ${
    Math.min(inBudget.length, 100).toLocaleString()} of ${inBudget.length.toLocaleString()}</span>`;
  el.results.appendChild(head);

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
el.browseSort.addEventListener('change', () => renderBrowse());
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

el.demoBtn.addEventListener('click', () => {
  el.title.value = 'Cortical thickness and white matter integrity predict naming recovery after left-hemisphere stroke';
  el.abstract.value = `Anomia is the most common and persistent deficit after left hemisphere stroke. We used structural MRI and diffusion weighted imaging in 84 chronic stroke survivors with aphasia to test whether cortical thickness in spared left temporal cortex and fractional anisotropy of the arcuate fasciculus predict naming performance on the Philadelphia Naming Test. Lesion load was quantified using voxel based lesion symptom mapping. Multivariate regression showed that residual cortical thickness in the posterior middle temporal gyrus and arcuate fasciculus microstructure each explained unique variance in naming accuracy beyond lesion volume alone. These neuroimaging biomarkers may support individualized prognosis and treatment planning in post stroke aphasia rehabilitation.`;
  el.abstract.dispatchEvent(new Event('input'));
  run();
});
