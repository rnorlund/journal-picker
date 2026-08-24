import { recommend, extractKeywords, buildQueries, config } from '../src/engine.js';

// Node's fetch cannot resolve a relative path and has no file:// support, so the
// catalog silently failed to load and every journal came back with no price and
// an abbreviated title. Point at the dev server instead.
//   python3 -m http.server 8899
config.dataBase = process.env.JP_DATA || 'http://localhost:8899/data';
import { loadFields, detectFields } from '../src/fields.js';
import { readFileSync } from 'fs';

const CASES = [{
  name: 'stroke aphasia structural MRI',
  title: 'Cortical thickness and white matter integrity predict naming recovery after stroke-induced aphasia',
  abstract: `Anomia is the most common and persistent deficit after left hemisphere stroke. We used structural MRI
and diffusion weighted imaging in 84 chronic stroke survivors with aphasia to test whether cortical thickness in
spared left temporal cortex and fractional anisotropy of the arcuate fasciculus predict naming performance on the
Philadelphia Naming Test. Lesion load was quantified with voxel based lesion symptom mapping. Multivariate
regression showed that residual cortical thickness in the posterior middle temporal gyrus and arcuate fasciculus
microstructure each explained unique variance in naming accuracy beyond lesion volume. These neuroimaging
biomarkers may support individualized prognosis and treatment planning in post stroke aphasia rehabilitation.`,
}, {
  name: 'resting-state fMRI methods',
  title: 'A deep learning framework for motion artifact correction in resting-state functional MRI',
  abstract: `Head motion remains a dominant source of artifact in resting state fMRI functional connectivity
estimates. We introduce a convolutional neural network trained on 12,000 scans from the Human Connectome Project
and ABCD study to denoise BOLD timeseries. Compared with standard ICA-FIX and censoring pipelines, our method
preserved more degrees of freedom while reducing distance-dependent artifact in the default mode network.
Test-retest reliability of graph theory metrics improved substantially. The tool is released as a BIDS App.`,
}];

const t0 = Date.now();
for (const c of CASES) {
  console.log('\n' + '='.repeat(78));
  console.log('CASE:', c.name);
  const kw = extractKeywords(c.title, c.abstract);

  const ids = JSON.parse(readFileSync('data/fields/index.json','utf8')).fields;
  const fields = ids.map(id => JSON.parse(readFileSync(`data/fields/${id}.json`,'utf8')));
  const detected = detectFields(`${c.title} ${c.abstract}`, fields);
  console.log('  fields :', detected.matched.map(m => m.field.id).join(', ') || '(none)');
  console.log('  queries:', buildQueries(kw, detected).map(p => `${p.label}[${p.weight}]`).join(' '));

  const started = Date.now();
  const out = await recommend(c, { onProgress: (s, d) => {
    if (s === 'retrieved') console.log('  retrieved:', d.works, 'works,', d.venues, 'venues', d.errors.length ? 'ERR:' + d.errors : '');
    if (s === 'topics') console.log('  topics:', d.topics.map(t => t.name).join(' | '));
  }});
  console.log(`  elapsed ${(Date.now() - started) / 1000}s | examined ${out.worksExamined} works`);
  console.log('  query recall:', out.probes.map(p => `${p.label}=${p.returned}/${p.total}`).join(' '));

  console.log('\n  TOP 15 JOURNALS (journals only):');
  const js = out.journals.filter(j => j.isJournal).slice(0, 15);
  for (const j of js) {
    const apc = j.apcKnown ? `$${j.apcUsd}` : 'APC?';
    console.log(`   ${(j.fit * 100).toFixed(0).padStart(3)}%  ${apc.padStart(6)} ${j.oaModel.padEnd(18)} m=${String(j.matchCount).padStart(2)} v=${String(j.topicWorks).padStart(4)} ${j.name}`);
  }
  const nonJ = out.journals.filter(j => !j.isJournal).slice(0, 4).map(j => j.name);
  console.log('  excluded as non-journal:', nonJ.join(', ') || '(none)');
  const free = js.filter(j => j.apcUsd === 0);
  console.log('  APC-free in top set:', free.map(j => j.name).join(', ') || '(none)');
}
console.log(`\nTOTAL ${(Date.now() - t0) / 1000}s`);
