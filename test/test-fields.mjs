import { readFileSync } from 'fs';
import { detectFields } from '../src/fields.js';

const ids = JSON.parse(readFileSync('data/fields/index.json','utf8')).fields;
const fields = ids.map(id => JSON.parse(readFileSync(`data/fields/${id}.json`,'utf8')));
console.log('loaded fields:', fields.map(f=>`${f.id}(${f.methods.length}m/${f.populations.length}p/${f.topics.length}t)`).join(' '));

const CASES = [
 ['brain-imaging', 'Cortical thickness and white matter integrity predict naming recovery after stroke',
  'We used structural MRI and diffusion weighted imaging in 84 chronic stroke survivors with aphasia. Fractional anisotropy of the arcuate fasciculus and cortical thickness in posterior middle temporal gyrus predicted naming. Voxel based lesion symptom mapping quantified lesion load.'],
 ['dental-oral', 'Deep learning detection of proximal caries on bitewing radiographs',
  'We trained a convolutional neural network on 12,000 bitewing radiographs to detect proximal dental caries. Performance was compared against three calibrated examiners. Cone beam computed tomography served as reference standard for a subset. The model improved caries detection sensitivity in permanent molars without increasing false positives, supporting computer-aided diagnosis in general dentistry.'],
 ['cardiovascular', 'Late gadolinium enhancement predicts ventricular arrhythmia in hypertrophic cardiomyopathy',
  'Cardiac magnetic resonance with late gadolinium enhancement and T1 mapping was performed in 430 patients with hypertrophic cardiomyopathy. Extracellular volume fraction and scar burden were quantified. Over 5 years follow-up, scar burden independently predicted ventricular arrhythmia and sudden cardiac death, beyond left ventricular ejection fraction and echocardiography measures.'],
 ['genetics', 'Rare variant burden in developmental disorders from whole exome sequencing',
  'We performed whole exome sequencing in 8,400 probands with developmental disorder and intellectual disability. Rare variant burden testing identified 14 novel genes. De novo mutations were enriched in chromatin regulators. Polygenic risk score analysis and expression quantitative trait loci colocalisation implicated shared regulatory architecture with autism.'],
 ['cross-field', 'Polygenic risk for atrial fibrillation and cardiac MRI phenotypes in UK Biobank',
  'We combined genome wide association study summary statistics with cardiac magnetic resonance imaging in 39,000 UK Biobank participants. Polygenic risk score for atrial fibrillation associated with left atrial volume measured by cardiac MRI. Mendelian randomisation supported a causal effect on myocardial strain.'],
];

let pass = 0, fail = 0;
for (const [expect, title, abstract] of CASES) {
  const d = detectFields(`${title} ${abstract}`, fields);
  const got = d.matched.map(m => m.field.id);
  const ok = expect === 'cross-field'
    ? (got.includes('genetics') && got.includes('cardiovascular'))
    : got[0] === expect;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  expected ${expect}`);
  console.log('   detected:', d.all.map(s=>`${s.field.id}=${s.score}`).join(' '));
  console.log('   matched :', got.join(', ') || '(none)');
  console.log('   methods :', d.methods.slice(0,6).join(' | '));
  console.log('   populns :', d.populations.slice(0,6).join(' | '));
  ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
