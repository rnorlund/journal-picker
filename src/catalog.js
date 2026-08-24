/**
 * catalog.js — precomputed journal catalogs, one per research field.
 *
 * Built offline by scripts/build-catalog.py (FIELD=<id>) from OpenAlex + DOAJ,
 * so the running app needs no metered API call to answer "what is this journal,
 * what does it cost, and does it publish this kind of work at volume".
 *
 * Two reasons that matters: the public site works for a visitor with no API key
 * at all, and the catalog reaches the long tail of free-to-publish journals a
 * live relevance query never surfaces (95 diamond-OA venues in brain imaging
 * alone, versus the 1 a live search found).
 *
 * A manuscript can belong to several fields at once, so catalogs are loaded as
 * a set and merged: in-field publication counts are summed across the loaded
 * fields, which is what you want for a cardiac-genetics paper.
 */

/** Where each field's catalog lives. Brain imaging keeps the original path. */
const CATALOG_PATH = (field, base) =>
  field === 'brain-imaging' ? `${base}/journals.json` : `${base}/catalogs/${field}.json`;

const rawCache = new Map();   // field -> payload | null
const mergedCache = new Map(); // cache key -> merged index

/** ISSNs come in many shapes; compare them in one. */
export const normIssn = (s) => {
  const m = String(s || '').toUpperCase().replace(/[^0-9X]/g, '');
  return m.length === 8 ? `${m.slice(0, 4)}-${m.slice(4)}` : null;
};

/** Journal titles vary by punctuation, case, and the leading article. */
export const normTitle = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/^the\s+/, '')
    // Europe PMC appends qualifiers: "Cortex; a journal devoted to..."
    .split(/[;:(]/)[0]
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Load one field's catalog. Missing catalogs are not an error — a field may
 *  have a lexicon before anyone has built its catalog. */
async function loadOne(field, base) {
  if (rawCache.has(field)) return rawCache.get(field);
  let payload = null;
  try {
    const res = await fetch(CATALOG_PATH(field, base));
    if (res.ok) payload = await res.json();
  } catch { /* offline, or not built yet */ }
  rawCache.set(field, payload);
  return payload;
}

/**
 * The catalog manifest: one entry per built field, with its journal count and
 * size. Lets the browse selector label itself and load exactly one catalog
 * instead of all of them -- at sixteen fields the full set is ~40 MB.
 *
 * Tolerates the older manifest shape, which was a plain array of field ids.
 */
export async function catalogManifest(base = 'data') {
  try {
    const res = await fetch(`${base}/catalogs/index.json`);
    if (res.ok) {
      const m = await res.json();
      const fields = m.fields;
      if (Array.isArray(fields) && fields.length) {
        return fields.map((f) => (typeof f === 'string'
          ? { id: f, name: f.replace(/-/g, ' '), journals: null }
          : f));
      }
    }
  } catch { /* not built yet */ }
  return [{ id: 'brain-imaging', name: 'Brain imaging', journals: null }];
}

/** Just the field ids that have a catalog. */
export async function listCatalogs(base = 'data') {
  return (await catalogManifest(base)).map((f) => f.id);
}

/**
 * Load and merge the catalogs for a set of fields.
 *
 * @param {string[]} fields  field ids; empty means every available catalog
 * @param {string}   base    data directory, relative to the page
 */
export async function loadCatalogs(fields, base = 'data') {
  const wanted = (fields && fields.length) ? [...fields] : await listCatalogs(base);
  const key = [...wanted].sort().join('|');
  if (mergedCache.has(key)) return mergedCache.get(key);

  const payloads = await Promise.all(wanted.map((f) => loadOne(f, base)));
  const loaded = wanted.filter((_, i) => payloads[i]);
  if (!loaded.length) return null;

  const byId = new Map();
  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    if (!payload) continue;
    const field = wanted[i];

    for (const j of payload.journals || []) {
      // Older catalogs used neuro_* names; accept both.
      const works = j.field_works ?? j.neuro_works ?? 0;
      const existing = byId.get(j.id);

      if (!existing) {
        byId.set(j.id, {
          ...j,
          fieldWorks: works,
          perField: { [field]: works },
        });
      } else {
        // Same journal seen in another field: sum in-field output so a
        // cross-field manuscript values journals strong in both.
        existing.fieldWorks += works;
        existing.perField[field] = works;
      }
    }
  }

  const byIssn = new Map();
  const byTitle = new Map();
  const journals = [];

  for (const j of byId.values()) {
    j.fieldShare = j.works_count ? +(j.fieldWorks / j.works_count).toFixed(3) : null;
    journals.push(j);

    const issns = [...(j.issn || []), j.issn_l].map(normIssn).filter(Boolean);
    j._issns = issns;
    for (const issn of issns) if (!byIssn.has(issn)) byIssn.set(issn, j);

    for (const name of [j.display_name, ...(j.alternate_titles || [])]) {
      const k = normTitle(name);
      if (k && !byTitle.has(k)) byTitle.set(k, j);
    }
  }

  journals.sort((a, b) => b.fieldWorks - a.fieldWorks);

  const index = {
    fields: loaded,
    generated: payloads.find(Boolean)?.generated || null,
    journals,
    byIssn,
    byTitle,
    size: journals.length,
  };
  mergedCache.set(key, index);
  return index;
}

/** Find a catalog record from whatever identifiers a search result carried. */
export function lookup(cat, { issns = [], title = '' } = {}) {
  if (!cat) return null;
  for (const raw of issns) {
    const hit = cat.byIssn.get(normIssn(raw));
    if (hit) return hit;
  }
  const key = normTitle(title);
  return key ? cat.byTitle.get(key) || null : null;
}

/** Venues you cannot submit a finished manuscript to. */
export function isSubmittable(rec) {
  if (!rec) return true; // unknown venue: let the caller decide
  return rec.kind === 'journal' && !rec.is_preprint_repository;
}
