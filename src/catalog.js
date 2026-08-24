/**
 * catalog.js — the precomputed journal catalog.
 *
 * Built offline by scripts/build-catalog.py from OpenAlex + DOAJ, so the running
 * app needs no metered API call to answer "what is this journal, what does it
 * cost, and does it publish this kind of work at volume".
 *
 * That matters for two reasons: the public site works for visitors with no API
 * key at all, and the catalog surfaces the long tail of free-to-publish
 * journals that a live relevance query never reaches (95 diamond-OA venues
 * versus the 1 a live search found).
 */

let catalog = null;

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

/**
 * Load and index the catalog. Returns null if it hasn't been built yet — the
 * engine degrades to live lookups rather than failing.
 */
export async function loadCatalog(url = 'data/journals.json') {
  if (catalog) return catalog;
  let payload;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }

  const byIssn = new Map();
  const byTitle = new Map();
  const journals = payload.journals || [];

  for (const j of journals) {
    const issns = [...(j.issn || []), j.issn_l].map(normIssn).filter(Boolean);
    j._issns = issns;
    for (const issn of issns) if (!byIssn.has(issn)) byIssn.set(issn, j);

    for (const name of [j.display_name, ...(j.alternate_titles || [])]) {
      const key = normTitle(name);
      if (key && !byTitle.has(key)) byTitle.set(key, j);
    }
  }

  catalog = {
    generated: payload.generated,
    journals,
    byIssn,
    byTitle,
    size: journals.length,
  };
  return catalog;
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

/** Venues you cannot submit a manuscript to. */
export function isSubmittable(rec) {
  if (!rec) return true; // unknown venue: let the caller decide
  return rec.kind === 'journal' && !rec.is_preprint_repository;
}
