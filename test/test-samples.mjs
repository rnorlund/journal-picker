import { recommend } from '../src/engine.js';
const out = await recommend({
  title: 'Cortical thickness and white matter integrity predict naming recovery after left-hemisphere stroke',
  abstract: `Anomia is the most common and persistent deficit after left hemisphere stroke. We used structural MRI and diffusion weighted imaging in 84 chronic stroke survivors with aphasia to test whether cortical thickness in spared left temporal cortex and fractional anisotropy of the arcuate fasciculus predict naming performance on the Philadelphia Naming Test. Lesion load was quantified using voxel based lesion symptom mapping. Multivariate regression showed that residual cortical thickness in the posterior middle temporal gyrus and arcuate fasciculus microstructure each explained unique variance in naming accuracy beyond lesion volume alone. These neuroimaging biomarkers may support individualized prognosis and treatment planning in post stroke aphasia rehabilitation.`,
});
for (const j of out.journals.filter(x=>x.isJournal).slice(0,5)) {
  console.log(`\n== ${j.name}  [${j.oaModel}] apc=${j.apcUsd} src=${j.apcSource}`);
  for (const p of j.samplePapers) console.log(`   facets=${p.facets} (${p.year}) ${p.title?.slice(0,88)}`);
}
const dia = out.journals.filter(j=>j.oaModel==='diamond');
console.log('\ndiamond OA found:', dia.map(j=>j.name).join(', ') || 'none');
