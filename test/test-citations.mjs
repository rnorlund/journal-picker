import { readFileSync } from 'fs';
import { buildGazetteer, matchCitations, citationAffinity, estimateRefCount } from '../src/citations.js';

// Build a catalog index shaped like catalog.js produces, straight from the file.
const payload = JSON.parse(readFileSync('data/journals.json','utf8'));
const catalog = { journals: payload.journals };
const gaz = buildGazetteer(catalog);
console.log('gazetteer entries:', gaz.length, 'from', catalog.journals.length, 'journals');

const REFS = `
1. Smith J, Doe A. Cortical thickness predicts naming in aphasia. NeuroImage. 2023;45:120-131.
2. Jones A, Patel R. White matter integrity and anomia. Brain and Language, 2022, 88, 45-59.
3. Lee K. Arcuate fasciculus microstructure after stroke. NeuroImage: Clinical 2021;30:102-115.
4. Garcia M et al. Lesion-symptom mapping of naming. Brain and Language. 2020;77:12-24.
5. Chen L. Predicting recovery in post-stroke aphasia. Brain Communications, 2022.
6. Okafor N. Network reorganisation in aphasia. Human Brain Mapping 2023;44:1123-1140.
7. Rossi P. Diffusion MRI of language tracts. NeuroImage 2024;55:99-110.
8. Novak T. Naming treatment outcomes. Aphasiology, 2021, 35, 500-518.
9. Ahmed S. Cortical atrophy and semantics. Neurobiology of Language 2023;4:210-228.
10. Weber F. Grey matter and speech. Cortex. 2022;150:88-99.
`;

const m = matchCitations(REFS, gaz);
console.log('references estimated:', estimateRefCount(REFS));
console.log('citations matched:', m.total, 'across', m.byId.size, 'journals');
const ranked = [...m.byId.values()].sort((a,b)=>b.count-a.count);
for (const r of ranked) console.log(`   ${String(r.count).padStart(2)}x  ${r.journal.display_name}`);

const aff = citationAffinity(m.byId);
console.log('affinity (top):', ranked.slice(0,3).map(r=>`${r.journal.display_name}=${aff.get(r.journal.id).toFixed(2)}`).join(' '));

// Guards: generic words must not fire, and overlapping names must not double count.
const noise = matchCitations('The brain is an organ. Cell biology and nature of science. Stroke happens.', gaz);
console.log('\nnoise test (should be 0 or near 0):', noise.total, [...noise.byId.values()].map(v=>v.journal.display_name));
const overlap = matchCitations('Human Brain Mapping 2023;44:1. NeuroImage: Clinical 2021.', gaz);
console.log('overlap test:', [...overlap.byId.values()].map(v=>`${v.journal.display_name}x${v.count}`));

let fail = 0;
const names = ranked.map(r=>r.journal.display_name);
for (const want of ['NeuroImage','Brain and Language','NeuroImage Clinical','Human Brain Mapping','Brain Communications','Aphasiology','Neurobiology of Language','Cortex']) {
  if (!names.includes(want)) { console.log('MISSING:', want); fail++; }
}
if (ranked.find(r=>r.journal.display_name==='NeuroImage')?.count !== 2) { console.log('NeuroImage should be cited 2x'); fail++; }
if (ranked.find(r=>r.journal.display_name==='Brain and Language')?.count !== 2) { console.log('Brain and Language should be 2x'); fail++; }
console.log(fail ? `\n${fail} FAILURES` : '\nall assertions passed');
process.exit(fail?1:0);
