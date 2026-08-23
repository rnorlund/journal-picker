/**
 * app.js — UI wiring for Journal Picker.
 *
 * Holds the last recommendation in memory so filter changes re-render instantly
 * without re-querying the API.
 */

import { recommend, config, quota } from './engine.js';

const $ = (id) => document.getElementById(id);
const el = {
  title: $('title'), abstract: $('abstract'), absCount: $('absCount'),
  goBtn: $('goBtn'), demoBtn: $('demoBtn'), status: $('status'),
  filterPanel: $('filterPanel'), results: $('results'), evidence: $('evidence'), empty: $('empty'),
  apcSlider: $('apcSlider'), apcOut: $('apcOut'), citeSlider: $('citeSlider'), citeOut: $('citeOut'),
  doajOnly: $('doajOnly'), coreOnly: $('coreOnly'), hidePreprint: $('hidePreprint'),
  agreeFile: $('agreeFile'), agreeBtn: $('agreeBtn'), agreeStatus: $('agreeStatus'),
  agreeOnly: $('agreeOnly'), agreeOnlyWrap: $('agreeOnlyWrap'), dropZone: $('dropZone'),
  themeBtn: $('themeBtn'), cardTpl: $('cardTpl'),
  apiKey: $('apiKey'), keySave: $('keySave'), keyClear: $('keyClear'),
  keyState: $('keyState'), keyBox: $('keyBox'), quota: $('quota'),
};

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

  switch (j.oaModel) {
    case 'diamond':
      return { oaCost: 0, minCost: 0, oaPossible: true, oaFree: true,
        amount: '$0', label: `diamond OA — no charge${attribution}`, cls: 'free' };
    case 'gold':
      return { oaCost: apc, minCost: apc, oaPossible: true, oaFree: apc === 0,
        amount: `$${apc.toLocaleString()}`, label: `APC — open access${attribution}`, cls: '' };
    case 'oa-apc-unknown':
      // Unknown is not free. Treat it as unaffordable under a cap so nobody
      // budgets around a price we could not actually verify.
      return { oaCost: null, minCost: null, oaPossible: true, oaFree: false,
        amount: 'APC n/a', label: 'open access, price not published', cls: 'unknown' };
    case 'hybrid':
      return { oaCost: apc, minCost: 0, oaPossible: true, oaFree: false,
        amount: `$${apc.toLocaleString()}`, label: `optional OA fee · $0 paywalled`, cls: '' };
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
  const kw = run.keywords;
  el.evidence.hidden = false;
  el.evidence.innerHTML = `
    <div class="panel-head"><h2>How these were found</h2></div>
    <div class="ev-grid">
      <div class="ev-block">
        <h4>Search probes</h4>
        <div class="chips">${run.probes.map((p) =>
          `<span class="chip q" title="${esc(p.total.toLocaleString())} indexed matches">${esc(p.query)}</span>`).join('')}</div>
      </div>
      <div class="ev-block">
        <h4>Detected research topics</h4>
        <div class="chips">${run.topics.map((t) => `<span class="chip">${esc(t.name)}</span>`).join('')}</div>
      </div>
      <div class="ev-block">
        <h4>Methods &amp; population detected</h4>
        <div class="chips">${[...kw.modalities.slice(0, 5), ...kw.populations.slice(0, 5)]
          .map((m) => `<span class="chip">${esc(m)}</span>`).join('') || '<span class="chip">none recognised</span>'}</div>
      </div>
      <div class="ev-block">
        <h4>Evidence base</h4>
        <div class="ev-stats">
          <div class="ev-stat"><b>${run.worksExamined.toLocaleString()}</b><span>similar papers read</span></div>
          <div class="ev-stat"><b>${run.venuesConsidered.toLocaleString()}</b><span>venues seen</span></div>
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
    hybrid: 'Hybrid — OA optional',
    subscription: 'Subscription',
  }[j.oaModel];
  if (oaLabel) {
    const cls = j.oaModel === 'diamond' ? 'b-cover'
      : j.oaModel === 'subscription' ? 'b-plain'
      : j.oaModel === 'oa-apc-unknown' ? 'b-warn' : 'b-oa';
    b.push([cls, oaLabel]);
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
  if (j.matchCount) {
    bits.push(`published <b>${j.matchCount}</b> paper${j.matchCount === 1 ? '' : 's'} closely matching yours`);
  }
  if (j.topicWorks) {
    bits.push(`<b>${j.topicWorks.toLocaleString()}</b> recent papers in your topic area`);
  }
  if (j.probesMatched.length > 2) {
    bits.push(`matched <b>${j.probesMatched.length}</b> different facets of your abstract`);
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

    // fit ring
    const pct = Math.round(j.fit * 100);
    const ring = node.querySelector('.ring-fg');
    const circ = 2 * Math.PI * 18;
    ring.style.strokeDasharray = `${circ}`;
    ring.style.strokeDashoffset = `${circ * (1 - Math.min(pct, 100) / 100)}`;
    node.querySelector('.fitnum').textContent = pct;

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
      <span class="wb">similarity <i><b style="width:${Math.round(j.simNorm * 100)}%"></b></i></span>
      <span class="wb">topic volume <i><b style="width:${Math.round(Math.min(j.topicWorks / 2500, 1) * 100)}%"></b></i></span>`;
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
 * OpenAlex credits and API key
 * ================================================================== */

function renderQuota() {
  if (quota.remaining == null) { el.quota.hidden = true; return; }
  el.quota.hidden = false;
  const searches = Math.floor(quota.remaining / 80); // ~80 credits per search
  el.quota.textContent = `${quota.remaining.toLocaleString()} credits · ~${searches} search${searches === 1 ? '' : 'es'} left`;
  el.quota.classList.toggle('out', quota.remaining <= 0);
  el.quota.classList.toggle('low', quota.remaining > 0 && searches < 3);
  el.quota.title = quota.limit ? `Limit ${quota.limit.toLocaleString()} credits` : '';
}

function setKeyState() {
  const has = !!config.apiKey;
  el.keyState.textContent = has ? 'active' : 'recommended';
  el.keyState.classList.toggle('set', has);
}

try {
  const savedKey = localStorage.getItem('jp-openalex-key');
  if (savedKey) { config.apiKey = savedKey; el.apiKey.value = savedKey; }
} catch {}
setKeyState();

el.keySave.addEventListener('click', () => {
  const v = el.apiKey.value.trim();
  config.apiKey = v || null;
  try {
    if (v) localStorage.setItem('jp-openalex-key', v);
    else localStorage.removeItem('jp-openalex-key');
  } catch {}
  setKeyState();
  el.status.classList.remove('err');
  el.status.textContent = v ? 'API key saved in this browser.' : 'API key cleared.';
});
el.keyClear.addEventListener('click', () => {
  el.apiKey.value = '';
  config.apiKey = null;
  try { localStorage.removeItem('jp-openalex-key'); } catch {}
  setKeyState();
});

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
    const out = await recommend({ title, abstract }, {
      onProgress: (stage, d) => {
        const msg = {
          probes: 'Building search probes…',
          retrieved: `Found ${d.works ?? ''} similar papers…`,
          topics: 'Measuring what each journal publishes…',
          enriched: 'Fetching journal metadata…',
          apc: 'Verifying open-access charges against DOAJ…',
        }[stage];
        if (msg) el.status.innerHTML = `<span class="spin"></span>${msg}`;
      },
    });
    lastRun = out;
    el.filterPanel.hidden = false;
    renderEvidence(out);
    render();
    renderQuota();
    el.status.textContent = `Done — ${out.journals.length} candidate venues ranked.`;
    el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    renderQuota();
    el.status.textContent = err.message || 'Something went wrong.';
    el.status.classList.add('err');
    // Out of credits and no key set: put the fix directly in front of them.
    if (err.quotaExhausted && !config.apiKey) el.keyBox.open = true;
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
