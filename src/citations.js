/**
 * citations.js — work out which journals a manuscript cites.
 *
 * Why this matters more than it looks: the journals you cite are the journals
 * whose conversation you are joining. Editors check whether a submission
 * engages with what they have published, and reviewers are drawn from those
 * same venues. It is one of the strongest available signals of fit, and it is
 * information only the author has — no bibliometric database can infer it from
 * a title and abstract.
 *
 * Implementation note: rather than parsing reference strings (fragile across
 * citation styles), we use the journal catalog as a gazetteer and look for any
 * known journal name, alternate title, or abbreviation in the pasted text.
 * That needs no network calls and copes with any style, because every style
 * prints the journal name somewhere.
 */

/** Normalise text for matching: lowercase, punctuation to spaces, collapsed. */
const norm = (s) =>
  ` ${String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;

/**
 * Short journal names are also ordinary words: Brain, Cortex, Cell, Stroke,
 * Circulation, Heart, Pain, Sleep. Blocking them outright would lose real
 * journals -- Cortex is exactly the sort of venue an aphasia paper should see.
 *
 * Instead, short names must appear in citation context: reference lists always
 * print a year or volume next to the journal name ("Cortex. 2022;150:88"),
 * whereas prose does not ("...activity in the cortex was..."). Names of three
 * or more words identify themselves and need no such proof.
 */
const CONTEXT_MAX_WORDS = 2;

/** A year or volume/page run within the next few tokens. */
const CITATION_CONTEXT = /^\s*(?:vol\s+)?(?:\d{1,4}\s+){0,2}(?:19|20)\d{2}\b|^\s*\d{1,4}\s+\d{1,5}\b/;

/**
 * Build the gazetteer once per catalog: every name variant, longest first, so
 * "Human Brain Mapping" is consumed before the bare word "Brain" is considered.
 */
export function buildGazetteer(catalog) {
  if (!catalog) return [];
  const entries = [];

  for (const j of catalog.journals) {
    const seen = new Set();
    const names = [j.display_name, j.abbreviated_title, ...(j.alternate_titles || [])];

    for (const raw of names) {
      if (!raw) continue;
      const n = norm(raw).trim();
      if (n.length < 5) continue;                       // too short to be evidence
      if (seen.has(n)) continue;
      seen.add(n);
      const words = n.split(' ').length;
      entries.push({
        name: n, journal: j, len: n.length,
        needsContext: words <= CONTEXT_MAX_WORDS,
      });
    }
  }

  entries.sort((a, b) => b.len - a.len);
  return entries;
}

/**
 * Count citations per journal in a pasted reference list.
 *
 * Matches are consumed so overlapping names cannot double count: text matched
 * by "Human Brain Mapping" is no longer available to "Brain".
 *
 * @param {string} text      the pasted references / bibliography
 * @param {Array}  gazetteer from buildGazetteer()
 * @returns {{ byId: Map<string, {journal, count}>, total: number, refCount: number }}
 */
export function matchCitations(text, gazetteer) {
  const hay = norm(text);
  const byId = new Map();
  let total = 0;

  if (!hay.trim() || !gazetteer.length) {
    return { byId, total: 0, refCount: 0 };
  }

  // Mask of already-consumed characters.
  const used = new Uint8Array(hay.length);

  for (const entry of gazetteer) {
    const needle = ` ${entry.name} `;
    let from = 0;
    let count = 0;

    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      from = at + 1;

      // Skip if any of this span was already claimed by a longer name.
      let free = true;
      for (let i = at; i < at + needle.length; i++) {
        if (used[i]) { free = false; break; }
      }
      if (!free) continue;

      // Short names only count with a year or volume beside them.
      if (entry.needsContext) {
        const after = hay.slice(at + needle.length - 1, at + needle.length + 24);
        if (!CITATION_CONTEXT.test(after)) continue;
      }

      // Claim the span, but leave the boundary spaces available so adjacent
      // matches are still possible.
      for (let i = at + 1; i < at + needle.length - 1; i++) used[i] = 1;
      count++;
    }

    if (count) {
      const id = entry.journal.id;
      const cur = byId.get(id);
      if (cur) cur.count += count;
      else byId.set(id, { journal: entry.journal, count });
      total += count;
    }
  }

  // Rough reference count, for reporting how much of the list we recognised.
  const refCount = estimateRefCount(text);
  return { byId, total, refCount };
}

/** Best-effort count of how many references were pasted. */
export function estimateRefCount(text) {
  const t = String(text || '');
  if (!t.trim()) return 0;

  // Numbered lists ("1." / "[1]") are the most reliable signal.
  const numbered = t.match(/(^|\n)\s*(\[\d{1,3}\]|\(?\d{1,3}[.)])\s+\S/g);
  if (numbered && numbered.length >= 3) return numbered.length;

  // Otherwise count years in parentheses, then fall back to non-empty lines.
  const years = t.match(/\((19|20)\d{2}[a-z]?\)/g);
  if (years && years.length >= 3) return years.length;

  const doi = t.match(/10\.\d{4,9}\//g);
  if (doi && doi.length >= 3) return doi.length;

  return t.split(/\n+/).filter((l) => l.trim().length > 40).length;
}

/**
 * Turn raw counts into a 0..1 affinity per journal.
 *
 * Diminishing returns: citing a journal eight times is a stronger signal than
 * once, but not eight times stronger, and we do not want one heavily-cited
 * venue to flatten everything else.
 */
export function citationAffinity(byId) {
  const out = new Map();
  if (!byId.size) return out;
  const max = Math.max(...[...byId.values()].map((v) => v.count));
  const denom = Math.log1p(max);
  for (const [id, v] of byId) {
    out.set(id, denom > 0 ? Math.log1p(v.count) / denom : 0);
  }
  return out;
}
