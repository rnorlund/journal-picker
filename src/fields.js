/**
 * fields.js — research-field definitions and auto-detection.
 *
 * Everything field-specific lives in data/fields/*.json, so adding a discipline
 * is a data drop-in rather than a code change. Each definition supplies:
 *
 *   signals     — terms that merely identify the field (used for detection)
 *   methods     — [needle, probeTerm] pairs for techniques/instruments
 *   populations — [needle, probeTerm] pairs for populations/domains
 *   topics      — OpenAlex topic ids, used when building the journal catalog
 *
 * A manuscript is matched against every field and may legitimately belong to
 * several (a cardiac-MRI genetics paper is all three). We use the union of the
 * matching fields' lexicons rather than forcing a single choice.
 */

/** Registered field files, in priority order. */
export const FIELD_FILES = [
  'brain-imaging',
  'aphasia-stroke',
  'dental-oral',
  'cardiovascular',
  'genetics',
];

const cache = new Map();

/** Load one field definition, tolerating fields that aren't authored yet. */
async function loadField(id, base = 'data/fields') {
  if (cache.has(id)) return cache.get(id);
  let def = null;
  try {
    const res = await fetch(`${base}/${id}.json`);
    if (res.ok) def = await res.json();
  } catch { /* not authored yet, or offline */ }
  cache.set(id, def);
  return def;
}

/**
 * Load every available field definition. `index.json` lists which files
 * actually exist, so we never fire requests for fields not yet authored.
 */
export async function loadFields(base = 'data/fields') {
  let ids = FIELD_FILES;
  try {
    const res = await fetch(`${base}/index.json`);
    if (res.ok) {
      const manifest = await res.json();
      if (Array.isArray(manifest.fields) && manifest.fields.length) {
        // Keep FIELD_FILES order for anything listed, then any extras.
        const listed = new Set(manifest.fields);
        ids = [...FIELD_FILES.filter((f) => listed.has(f)),
               ...manifest.fields.filter((f) => !FIELD_FILES.includes(f))];
      }
    }
  } catch { /* fall back to the built-in list */ }
  const loaded = await Promise.all(ids.map((id) => loadField(id, base)));
  return loaded.filter(Boolean);
}

const normalise = (text) =>
  ` ${(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

/** Count how many of a term list appear in the text. */
function hits(hay, terms) {
  const found = [];
  for (const t of terms || []) {
    if (hay.includes(` ${t}`)) found.push(t);
  }
  return found;
}

/**
 * Score each field against a manuscript and return them ranked.
 * A field qualifies if it has real lexicon traction, not just one stray word.
 */
export function detectFields(text, fields) {
  const hay = normalise(text);
  const scored = [];

  for (const f of fields) {
    const sig = hits(hay, f.signals);
    const meth = (f.methods || []).filter(([needle]) => hay.includes(` ${needle}`));
    const pop = (f.populations || []).filter(([needle]) => hay.includes(` ${needle}`));

    // Methods and populations are much stronger evidence than bare signals.
    const score = sig.length * 1 + meth.length * 3 + pop.length * 2;
    if (score > 0) {
      scored.push({
        field: f,
        score,
        signalHits: sig,
        methodHits: meth.map(([, probe]) => probe),
        populationHits: pop.map(([, probe]) => probe),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  // Always return the same shape, including when nothing matched — callers
  // read `all` for diagnostics and should not have to guard against it.
  if (!scored.length) {
    return { matched: [], all: [], primary: null, methods: [], populations: [] };
  }

  // Keep fields within reach of the leader; drop incidental single-word matches.
  const top = scored[0].score;
  const matched = scored.filter((s) => s.score >= Math.max(3, top * 0.35));

  const dedupe = (arr) => [...new Set(arr)];
  return {
    matched,
    primary: matched[0].field,
    all: scored,
    methods: dedupe(matched.flatMap((m) => m.methodHits)),
    populations: dedupe(matched.flatMap((m) => m.populationHits)),
  };
}
