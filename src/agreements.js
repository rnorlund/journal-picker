/**
 * agreements.js — Institutional open-access agreement spreadsheet parser.
 *
 * Parses publisher "open access agreement" workbooks (.xlsx / .xlsm) and flat
 * text tables (.csv / .tsv) into a normalized journal list, then builds fast
 * lookup indexes by ISSN and by normalized title.
 *
 * Design constraints:
 *   - Pure ES module, ZERO dependencies, no CDN imports, no node:* imports.
 *   - Runs identically in Node 22 and in modern browsers.
 *   - OOXML archives are unzipped by hand: the ZIP central directory is parsed
 *     here and DEFLATE entries are inflated with the platform-native
 *     `DecompressionStream('deflate-raw')`.
 *   - XML is read with a hand-written tokenizer (no DOMParser dependency, since
 *     DOMParser is not a Node global).
 *
 * Public API:
 *   parseAgreementFile(arrayBuffer, filename) -> Promise<ParsedFile>
 *   normalizeTitle(s) -> string
 *   normalizeIssn(s) -> string|null
 *   buildAgreementIndex(parsedFiles) -> { byIssn, byTitle, count, publishers }
 *   lookupAgreement(index, { issns, title }) -> entry|null
 */

/* ========================================================================== *
 * Binary helpers
 * ========================================================================== */

/** Read a little-endian unsigned 16-bit integer. */
function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}

/** Read a little-endian unsigned 32-bit integer. */
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/**
 * Read a little-endian unsigned 64-bit integer as a JS number.
 * ZIP64 sizes far exceed anything we could hold in memory anyway, so the 2^53
 * precision limit of Number is not a practical concern here.
 */
function u64(b, o) {
  return u32(b, o + 4) * 4294967296 + u32(b, o);
}

const UTF8_DECODER = new TextDecoder('utf-8');

/** Decode bytes as UTF-8, stripping a leading BOM if present. */
function decodeUtf8(bytes) {
  let out = UTF8_DECODER.decode(bytes);
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  return out;
}

/* ========================================================================== *
 * DEFLATE via the platform DecompressionStream
 * ========================================================================== */

/**
 * Inflate a raw DEFLATE byte stream (no zlib/gzip wrapper).
 * Uses the native `DecompressionStream`, present in Node 18+ and all evergreen
 * browsers; throws a descriptive error where it is missing.
 *
 * @param {Uint8Array} bytes raw deflate payload
 * @returns {Promise<Uint8Array>} inflated bytes
 */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'DecompressionStream is unavailable in this environment; ' +
        'cannot inflate DEFLATE ZIP entries.'
    );
  }
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // Deliberately not awaited: the write only settles once the reader below
  // starts draining, so awaiting here would deadlock on large entries.
  writer.write(bytes).then(
    () => writer.close(),
    () => {
      /* the error surfaces through the reader */
    }
  );

  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/* ========================================================================== *
 * ZIP reader (central-directory based, ZIP64 aware)
 * ========================================================================== */

const SIG_EOCD = 0x06054b50; // end of central directory record
const SIG_EOCD64 = 0x06064b50; // ZIP64 end of central directory record
const SIG_EOCD64_LOC = 0x07064b50; // ZIP64 EOCD locator
const SIG_CDH = 0x02014b50; // central directory file header
const SIG_LFH = 0x04034b50; // local file header

/**
 * Locate the End Of Central Directory record by scanning backwards.
 * @returns {number} byte offset of the EOCD signature
 */
function findEocd(b) {
  // EOCD is 22 bytes plus up to 65535 bytes of archive comment.
  const min = Math.max(0, b.length - (22 + 0xffff));
  for (let i = b.length - 22; i >= min; i--) {
    if (u32(b, i) === SIG_EOCD) return i;
  }
  throw new Error('Not a ZIP archive: end-of-central-directory record not found.');
}

/**
 * Parse a ZIP64 extended-information extra field, filling in any value that
 * was flagged as 0xFFFFFFFF in the fixed-width central directory header.
 */
function applyZip64Extra(extra, rec) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = u16(extra, p);
    const size = u16(extra, p + 2);
    const body = p + 4;
    if (id === 0x0001) {
      // Fields appear in a fixed order, but only for values that overflowed.
      let q = body;
      if (rec.uncompressedSize === 0xffffffff && q + 8 <= body + size) {
        rec.uncompressedSize = u64(extra, q);
        q += 8;
      }
      if (rec.compressedSize === 0xffffffff && q + 8 <= body + size) {
        rec.compressedSize = u64(extra, q);
        q += 8;
      }
      if (rec.localOffset === 0xffffffff && q + 8 <= body + size) {
        rec.localOffset = u64(extra, q);
        q += 8;
      }
      return;
    }
    p = body + size;
  }
}

/**
 * Read a ZIP archive's central directory.
 * @param {Uint8Array} bytes whole archive
 * @returns {Map<string, object>} entry name -> record
 */
function readZipDirectory(bytes) {
  const eocd = findEocd(bytes);
  let cdOffset = u32(bytes, eocd + 16);
  let cdSize = u32(bytes, eocd + 12);
  let entryCount = u16(bytes, eocd + 10);

  // ZIP64: the locator sits immediately before the EOCD.
  const locAt = eocd - 20;
  if (locAt >= 0 && u32(bytes, locAt) === SIG_EOCD64_LOC) {
    const z64At = u64(bytes, locAt + 8);
    if (z64At >= 0 && z64At + 56 <= bytes.length && u32(bytes, z64At) === SIG_EOCD64) {
      entryCount = u64(bytes, z64At + 32);
      cdSize = u64(bytes, z64At + 40);
      cdOffset = u64(bytes, z64At + 48);
    }
  }
  if (cdOffset + cdSize > bytes.length) {
    // Some writers emit a prefixed archive (e.g. self-extractor); realign.
    const delta = bytes.length - cdSize - 22;
    if (delta >= 0) cdOffset = delta;
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < entryCount && p + 46 <= bytes.length; i++) {
    if (u32(bytes, p) !== SIG_CDH) break;
    const rec = {
      method: u16(bytes, p + 10),
      compressedSize: u32(bytes, p + 20),
      uncompressedSize: u32(bytes, p + 24),
      localOffset: u32(bytes, p + 42),
    };
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    rec.name = decodeUtf8(bytes.subarray(p + 46, p + 46 + nameLen));
    if (extraLen) {
      applyZip64Extra(bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), rec);
    }
    entries.set(rec.name, rec);
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) throw new Error('ZIP central directory contained no entries.');
  return entries;
}

/**
 * Extract one ZIP entry's bytes. Supports STORED (0) and DEFLATE (8).
 * Sizes come from the central directory, which stays authoritative even when
 * the local header defers them to a trailing data descriptor.
 */
async function readZipEntry(bytes, rec) {
  const off = rec.localOffset;
  if (off + 30 > bytes.length || u32(bytes, off) !== SIG_LFH) {
    throw new Error(`Bad local header for ZIP entry "${rec.name}".`);
  }
  const nameLen = u16(bytes, off + 26);
  const extraLen = u16(bytes, off + 28);
  const start = off + 30 + nameLen + extraLen;
  const end = start + rec.compressedSize;
  const raw = bytes.subarray(start, Math.min(end, bytes.length));
  if (rec.method === 0) return raw;
  if (rec.method === 8) return inflateRaw(raw);
  throw new Error(`Unsupported ZIP compression method ${rec.method} for "${rec.name}".`);
}

/** Read a ZIP entry and decode it as UTF-8 text ('' when the entry is absent). */
async function readZipText(bytes, entries, name) {
  const rec = entries.get(name);
  if (!rec) return '';
  return decodeUtf8(await readZipEntry(bytes, rec));
}

/* ========================================================================== *
 * XML tokenizer (DOMParser-free, identical in Node and browsers)
 * ========================================================================== */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode XML character/entity references in text or attribute values. */
function decodeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (m, g) => {
    if (g.charCodeAt(0) === 35 /* '#' */) {
      const cp =
        g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, g) ? NAMED_ENTITIES[g] : m;
  });
}

const ATTR_RE = /([^\s=/>][^\s=]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Parse a tag's raw attribute text into a plain object.
 * Namespaced attributes are additionally exposed under their local name, so
 * `r:id` is reachable as both `'r:id'` and `'id'`. Attribute order is
 * irrelevant to callers.
 */
function parseAttrs(raw) {
  const out = Object.create(null);
  if (!raw) return out;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    const key = m[1];
    const val = decodeXml(m[2] !== undefined ? m[2] : m[3]);
    out[key] = val;
    const colon = key.indexOf(':');
    if (colon !== -1) {
      const local = key.slice(colon + 1);
      if (!(local in out)) out[local] = val;
    }
  }
  return out;
}

/** Strip any namespace prefix from an element name. */
function localName(name) {
  const c = name.indexOf(':');
  return c === -1 ? name : name.slice(c + 1);
}

/**
 * Stream XML as tokens. Robust to self-closing tags, arbitrary attribute
 * order, '>' inside quoted attribute values, comments, CDATA, PIs and DTDs.
 *
 * Yields: {type:'open'|'selfclose', name, raw} | {type:'close', name}
 *       | {type:'text', text}   (text is NOT entity-decoded; callers decode)
 */
function* xmlTokens(xml) {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      if (i < n) yield { type: 'text', text: xml.slice(i) };
      return;
    }
    if (lt > i) yield { type: 'text', text: xml.slice(i, lt) };

    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      const text = xml.slice(lt + 9, e === -1 ? n : e);
      if (text) yield { type: 'text', text, cdata: true };
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt + 2);
      i = e === -1 ? n : e + 1;
      continue;
    }

    let j = lt + 1;
    let isClose = false;
    if (xml[j] === '/') {
      isClose = true;
      j++;
    }
    let k = j;
    while (k < n) {
      const c = xml.charCodeAt(k);
      // space, tab, LF, CR, '/', '>'
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47 || c === 62) break;
      k++;
    }
    const name = xml.slice(j, k);

    // Find the closing '>' while respecting quoted attribute values.
    let m = k;
    let quote = 0;
    while (m < n) {
      const c = xml.charCodeAt(m);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) {
        quote = c;
      } else if (c === 62) {
        break;
      }
      m++;
    }
    const raw = xml.slice(k, m);
    i = m < n ? m + 1 : n;

    if (isClose) yield { type: 'close', name };
    else yield { type: raw.endsWith('/') ? 'selfclose' : 'open', name, raw };
  }
}

/* ========================================================================== *
 * OOXML part parsers
 * ========================================================================== */

/**
 * Parse xl/workbook.xml -> ordered [{ name, rid, state }].
 * Sheet order in this part is the workbook's display order.
 */
function parseWorkbook(xml) {
  const sheets = [];
  for (const t of xmlTokens(xml)) {
    if (t.type !== 'open' && t.type !== 'selfclose') continue;
    if (localName(t.name) !== 'sheet') continue;
    const a = parseAttrs(t.raw);
    if (a.name === undefined) continue;
    sheets.push({ name: a.name, rid: a['r:id'] || a.id || null, state: a.state || 'visible' });
  }
  return sheets;
}

/** Parse xl/_rels/workbook.xml.rels -> Map rId -> target path. */
function parseRels(xml) {
  const map = new Map();
  for (const t of xmlTokens(xml)) {
    if (t.type !== 'open' && t.type !== 'selfclose') continue;
    if (localName(t.name) !== 'Relationship') continue;
    const a = parseAttrs(t.raw);
    if (a.Id && a.Target) map.set(a.Id, a.Target);
  }
  return map;
}

/**
 * Resolve a relationship target to a ZIP entry path.
 * Targets are usually relative to xl/ ("worksheets/sheet1.xml") but can be
 * absolute ("/xl/worksheets/sheet1.xml").
 */
function resolveTarget(target, entries) {
  const clean = target.replace(/^\.\//, '');
  const candidates = clean.startsWith('/') ? [clean.slice(1)] : ['xl/' + clean, clean];
  for (const c of candidates) if (entries.has(c)) return c;
  // Last resort: match on basename.
  const base = clean.split('/').pop();
  for (const name of entries.keys()) {
    if (name.endsWith('/' + base)) return name;
  }
  return null;
}

/**
 * Parse xl/sharedStrings.xml into an array of plain strings.
 * Handles multiple <t> runs inside one <si> (rich text), xml:space="preserve"
 * (run text is never trimmed), and skips <rPh> phonetic runs.
 */
function parseSharedStrings(xml) {
  const table = [];
  if (!xml) return table;

  let inSi = false;
  let inT = false;
  let phoneticDepth = 0;
  let buf = '';

  for (const tok of xmlTokens(xml)) {
    if (tok.type === 'open' || tok.type === 'selfclose') {
      const ln = localName(tok.name);
      if (ln === 'si') {
        if (tok.type === 'selfclose') {
          table.push('');
        } else {
          inSi = true;
          buf = '';
          phoneticDepth = 0;
        }
      } else if (ln === 'rPh') {
        if (tok.type === 'open') phoneticDepth++;
      } else if (ln === 't' && inSi && phoneticDepth === 0) {
        if (tok.type === 'open') inT = true;
      }
    } else if (tok.type === 'close') {
      const ln = localName(tok.name);
      if (ln === 't') inT = false;
      else if (ln === 'rPh') phoneticDepth = Math.max(0, phoneticDepth - 1);
      else if (ln === 'si' && inSi) {
        table.push(decodeXml(buf));
        inSi = false;
        buf = '';
      }
    } else if (tok.type === 'text' && inT) {
      buf += tok.text;
    }
  }
  return table;
}

/** Convert a column reference ("A", "AB", "C7") to a 0-based column index. */
function colRefToIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break; // stop at the row digits
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/**
 * Parse a worksheet XML part into a sparse grid: an array of rows, each row a
 * sparse array of strings indexed by column position.
 *
 * Cells are placed by their `r` reference, never by document order, because
 * empty cells are omitted from the XML entirely.
 *
 * Cell value types handled:
 *   t="s"          -> index into the shared string table
 *   t="inlineStr"  -> <is><t>text</t></is>
 *   t="str"        -> cached formula string result in <v>
 *   t="b"          -> boolean, rendered TRUE/FALSE
 *   t="e"          -> error, dropped
 *   absent / "n"   -> number, kept as its literal text
 */
function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  let row = null;
  let autoRow = 0;

  let cellCol = -1;
  let cellType = '';
  let inV = false;
  let inIs = false;
  let inT = false;
  let buf = '';

  const flushCell = () => {
    if (cellCol < 0 || !row) {
      cellCol = -1;
      cellType = '';
      buf = '';
      return;
    }
    let val = decodeXml(buf);
    if (cellType === 's') {
      const idx = parseInt(val, 10);
      val =
        Number.isFinite(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : '';
    } else if (cellType === 'e') {
      val = '';
    } else if (cellType === 'b') {
      val = val === '1' ? 'TRUE' : val === '0' ? 'FALSE' : val;
    }
    if (val !== '') row[cellCol] = val;
    cellCol = -1;
    cellType = '';
    buf = '';
  };

  for (const tok of xmlTokens(xml)) {
    if (tok.type === 'open' || tok.type === 'selfclose') {
      const ln = localName(tok.name);
      if (ln === 'c') {
        const a = parseAttrs(tok.raw);
        buf = '';
        cellType = a.t || '';
        cellCol = a.r ? colRefToIndex(a.r) : -1;
        if (cellCol < 0 && row) cellCol = row.length; // no ref: append
        if (tok.type === 'selfclose') flushCell();
      } else if (ln === 'v') {
        inV = tok.type === 'open';
      } else if (ln === 'is') {
        if (tok.type === 'open') inIs = true;
      } else if (ln === 't') {
        inT = tok.type === 'open';
      } else if (ln === 'row') {
        const a = parseAttrs(tok.raw);
        const rn = a.r ? parseInt(a.r, 10) : NaN;
        autoRow = Number.isFinite(rn) ? rn : autoRow + 1;
        row = [];
        if (tok.type === 'selfclose') {
          rows.push(row);
          row = null;
        }
      } else if (ln === 'f') {
        // Formula source text must not be mistaken for the cached value.
        inV = false;
      }
    } else if (tok.type === 'close') {
      const ln = localName(tok.name);
      if (ln === 'v') inV = false;
      else if (ln === 't') inT = false;
      else if (ln === 'is') inIs = false;
      else if (ln === 'c') flushCell();
      else if (ln === 'row') {
        if (row) rows.push(row);
        row = null;
      }
    } else if (tok.type === 'text') {
      if (inV || (inIs && inT) || (cellType === 'inlineStr' && inT)) buf += tok.text;
    }
  }
  if (row) rows.push(row);
  return rows;
}

/* ========================================================================== *
 * CSV / TSV
 * ========================================================================== */

/**
 * Detect the most likely delimiter by counting candidates outside quoted
 * regions across the first 64 KB.
 */
function detectDelimiter(text) {
  const sample = text.slice(0, 64 * 1024);
  const counts = { '\t': 0, ',': 0, ';': 0, '|': 0 };
  let inQuotes = false;
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (ch === '"') {
      if (inQuotes && sample[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ',';
  for (const k of Object.keys(counts)) if (counts[k] > counts[best]) best = k;
  return counts[best] === 0 ? ',' : best;
}

/**
 * RFC 4180-style delimited text parser.
 * Handles quoted fields containing the delimiter, embedded newlines and
 * doubled quotes, plus CRLF / CR / LF line endings.
 */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      sawAny = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAny = false;
    } else {
      field += ch;
      sawAny = true;
    }
  }
  if (field !== '' || sawAny || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ========================================================================== *
 * Normalization
 * ========================================================================== */

const COMBINING_MARKS_RE = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃰︠-︯]/g;
const CURLY_SINGLE_RE = /[‘’‚‛′]/g;
const CURLY_DOUBLE_RE = /[“”„″]/g;
const DASHES_RE = /[‐-―−]/g;
const NBSP_RE = /[   ⁠﻿]/g;
const LEADING_ARTICLE_RE = /^the\s+/;
const PUNCT_RE = /[^a-z0-9]+/g;

/**
 * Normalize a journal title for fuzzy equality:
 * lowercase, strip diacritics, '&' -> 'and', drop punctuation, collapse
 * whitespace, drop a leading "the ".
 *
 * @param {*} s
 * @returns {string} '' when the input yields nothing usable
 */
export function normalizeTitle(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).toLowerCase();
  // Decompose, then drop combining marks, to strip diacritics.
  t = t.normalize('NFD').replace(COMBINING_MARKS_RE, '');
  // Fold typographic look-alikes before punctuation removal.
  t = t.replace(NBSP_RE, ' ').replace(CURLY_SINGLE_RE, "'").replace(CURLY_DOUBLE_RE, '"');
  t = t.replace(DASHES_RE, '-');
  // Letters that NFD leaves intact.
  t = t
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    .replace(/đ/g, 'd')
    .replace(/ł/g, 'l');
  t = t.replace(/&/g, ' and ');
  t = t.replace(PUNCT_RE, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(LEADING_ARTICLE_RE, '');
  return t;
}

/** Tokens that show up in ISSN columns but are not ISSNs. */
const ISSN_JUNK = new Set([
  '',
  'na',
  'n/a',
  'n.a.',
  'nan',
  'none',
  'null',
  'tbd',
  'tba',
  'web only',
  'webonly',
  'web-only',
  'online only',
  'print only',
  'not applicable',
  'no issn',
  'pending',
  'various',
  '-',
  '--',
  'x',
]);

/**
 * Normalize and validate an ISSN.
 *
 * Accepts hyphenated or bare input, tolerates surrounding whitespace and an
 * "ISSN:"/"eISSN:" prefix, and verifies the mod-11 check digit. Values that
 * fail the checksum, are structurally wrong, or are placeholder text ('Web
 * Only', 'n/a', ...) return null.
 *
 * Short numeric input (5-7 digits, typical of a spreadsheet that stored the
 * ISSN as a number and dropped leading zeros) is zero-padded, but is still
 * only accepted when the checksum validates.
 *
 * @param {*} s
 * @returns {string|null} 'NNNN-NNNC' where C is a digit or 'X', else null
 */
export function normalizeIssn(s) {
  if (s === null || s === undefined) return null;
  let raw = String(s).replace(NBSP_RE, ' ').trim();
  if (!raw) return null;
  if (ISSN_JUNK.has(raw.toLowerCase())) return null;

  raw = raw.replace(/^(e-?|p-?)?issn\s*[:.]?\s*/i, '');
  // Keep digits and X only; every real separator is punctuation.
  const core = raw.toUpperCase().replace(/[^0-9X]/g, '');
  if (!core) return null;

  // Zero-pad shorter numeric input (up to three lost leading zeros, e.g. a
  // cell holding the number 68993 for ISSN 0006-8993). The checksum below is
  // what actually gates acceptance.
  let candidate;
  if (core.length >= 5 && core.length <= 8) candidate = core.padStart(8, '0');
  else return null;

  if (!/^[0-9]{7}[0-9X]$/.test(candidate)) return null;
  // 0000-000X passes the arithmetic but is never a real ISSN.
  if (candidate.slice(0, 7) === '0000000') return null;

  let sum = 0;
  for (let i = 0; i < 7; i++) sum += (candidate.charCodeAt(i) - 48) * (8 - i);
  const rem = sum % 11;
  const check = rem === 0 ? 0 : 11 - rem;
  const expected = check === 10 ? 'X' : String(check);
  if (expected !== candidate[7]) return null;

  return candidate.slice(0, 4) + '-' + candidate.slice(4);
}

/** Split a cell that may hold several ISSNs and normalize each one. */
function extractIssns(cell) {
  if (!cell) return [];
  const out = [];
  for (const part of String(cell).split(/[,;/|]|\s{2,}|\band\b/i)) {
    const n = normalizeIssn(part);
    if (n && !out.includes(n)) out.push(n);
  }
  if (!out.length) {
    // The whole cell may be one value that merely contained a separator, e.g.
    // "1234-5678 (print)".
    const n = normalizeIssn(cell);
    if (n) out.push(n);
  }
  return out;
}

/* ========================================================================== *
 * Header detection
 * ========================================================================== */

/** Collapse a header cell to a comparable key. */
function headerKey(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(NBSP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Score a header cell's likelihood of naming the journal-title column.
 * Higher wins; 0 means "not a title column".
 *
 * Acronym columns ("Journal Acronym", "Conference Proceedings Acronym") are
 * explicitly rejected — they frequently sit to the left of the real title.
 */
function titleScore(key) {
  if (!key || key.length > 60) return 0;
  if (/acronym|abbrev|short title|code$|\bid\b/.test(key)) return 0;
  if (/isbn|issn|doi|url|link|publisher|price|apc|discount|fee|note/.test(key)) return 0;

  if (key === 'journal title' || key === 'journal titles') return 100;
  if (key === 'journal name' || key === 'journal names') return 98;
  if (/^journal\s*\/?\s*conference\s*(name|title)$/.test(key)) return 96;
  if (/journal.*(title|name)/.test(key)) return 94;
  if (/(conference|proceedings).*(title|name)/.test(key)) return 88;
  if (key === 'title' || key === 'titles') return 86;
  if (/^(publication|serial|book)\s(title|name)$/.test(key)) return 84;
  if (/\btitle\b/.test(key)) return 78;
  if (key === 'journal' || key === 'journals') return 70;
  if (key === 'name' || key === 'publication') return 40;
  return 0;
}

/** Values that identify a publishing-model column when its header is unclear. */
const MODEL_VOCAB = new Set([
  'hybrid',
  'hybrid journal',
  'pure oa',
  'pure open access',
  'full oa',
  'fully oa',
  'fully open access',
  'gold oa',
  'gold',
  'open access',
  'subscribe to open',
  'subscribe-to-open',
  's2o',
  'transformative',
  'transformative journal',
  'green',
  'mirror',
  'partner title',
  'read only',
  'sponsored oa',
]);

/**
 * Identify the columns of interest on a candidate header row.
 * @returns {object|null} { title, issns, model, url, productType, score, width }
 */
function classifyHeaderRow(cells) {
  let title = -1;
  let titleBest = 0;
  const issns = [];
  let model = -1;
  let url = -1;
  let productType = -1;
  let nonEmpty = 0;

  for (let c = 0; c < cells.length; c++) {
    const key = headerKey(cells[c]);
    if (!key) continue;
    nonEmpty++;

    const score = titleScore(key);
    if (score > titleBest) {
      titleBest = score;
      title = c;
    }
    if (/issn/.test(key)) {
      issns.push(c);
    } else if (model < 0 && /\bmodel\b/.test(key)) {
      model = c;
    } else if (model < 0 && /^(oa|open access)\s(type|status)$/.test(key)) {
      model = c;
    } else if (url < 0 && /\b(url|links?|website|homepage|web page)\b/.test(key)) {
      url = c;
    } else if (productType < 0 && /(product|content|material)\stype/.test(key)) {
      productType = c;
    }
  }
  if (title < 0 || !nonEmpty) return null;
  return { title, issns, model, url, productType, score: titleBest, width: nonEmpty };
}

/**
 * Fallback: find a column whose values are dominated by publishing-model
 * vocabulary, for sheets whose model column is unlabeled or oddly named.
 */
function guessModelColumn(rows, headerIndex, exclude) {
  const hits = new Map();
  const totals = new Map();
  const limit = Math.min(rows.length, headerIndex + 200);
  for (let r = headerIndex + 1; r < limit; r++) {
    const row = rows[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      if (exclude.has(c)) continue;
      const v = row[c];
      if (!v) continue;
      totals.set(c, (totals.get(c) || 0) + 1);
      if (MODEL_VOCAB.has(headerKey(v))) hits.set(c, (hits.get(c) || 0) + 1);
    }
  }
  let best = -1;
  let bestRatio = 0;
  for (const [c, h] of hits) {
    const total = totals.get(c) || 1;
    const ratio = h / total;
    if (total >= 5 && ratio > 0.6 && ratio > bestRatio) {
      best = c;
      bestRatio = ratio;
    }
  }
  return best;
}

/* ========================================================================== *
 * Table -> entries
 * ========================================================================== */

const MAX_HEADER_SCAN = 40; // rows to search for a header before giving up

/** True when a row holds no content at all. */
function rowIsEmpty(row) {
  if (!row) return true;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    if (v !== undefined && v !== null && String(v).trim() !== '') return false;
  }
  return true;
}

/** Trim one cell to a clean single-spaced string ('' when absent). */
function cellText(row, idx) {
  if (!row || idx < 0) return '';
  const v = row[idx];
  if (v === undefined || v === null) return '';
  return String(v).replace(NBSP_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Convert one sheet-shaped table into normalized entries.
 *
 * @param {Array<Array<string>>} rows sparse grid
 * @param {string} publisher sheet name (or file name for flat files)
 * @returns {{entries:object[], rows:number, header:object|null, headerRow:number}}
 */
function extractEntries(rows, publisher) {
  // 1. Locate the header row: the first row that exposes a title column.
  let headerIndex = -1;
  let header = null;
  const scanTo = Math.min(rows.length, MAX_HEADER_SCAN);
  for (let r = 0; r < scanTo; r++) {
    if (rowIsEmpty(rows[r])) continue;
    const cand = classifyHeaderRow(rows[r]);
    if (cand) {
      headerIndex = r;
      header = cand;
      break;
    }
  }
  if (!header) return { entries: [], rows: 0, header: null, headerRow: -1 };

  // 2. Model column fallback, driven by the values themselves.
  if (header.model < 0) {
    const exclude = new Set([header.title, header.url, ...header.issns]);
    header.model = guessModelColumn(rows, headerIndex, exclude);
  }

  // 3. Walk the data rows.
  const entries = [];
  const seen = new Set();
  const headerTitleKey = headerKey(rows[headerIndex][header.title]);
  let dataRows = 0;

  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (rowIsEmpty(row)) continue;
    dataRows++;

    const title = cellText(row, header.title);
    if (!title) continue;
    const tk = headerKey(title);
    // Repeated header bands are common in these workbooks.
    if (tk === headerTitleKey) continue;
    if (titleScore(tk) >= 86 && header.issns.every((c) => !cellText(row, c))) continue;

    const normTitle = normalizeTitle(title);
    if (!normTitle) continue;

    const issns = [];
    for (const c of header.issns) {
      for (const issn of extractIssns(cellText(row, c))) {
        if (!issns.includes(issn)) issns.push(issn);
      }
    }

    let model = cellText(row, header.model);
    if (!model || ISSN_JUNK.has(model.toLowerCase())) model = null;

    let url = cellText(row, header.url);
    if (!url || !/[.:]/.test(url)) url = null;

    // Drop exact duplicate rows within a single sheet.
    const key = normTitle + ' ' + issns.join(',');
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({ title, normTitle, issns, publisher, model, url });
  }

  return { entries, rows: dataRows, header, headerRow: headerIndex };
}

/* ========================================================================== *
 * Public: parseAgreementFile
 * ========================================================================== */

/** Normalize whatever buffer-ish input we were handed into a Uint8Array. */
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && typeof input === 'object' && input.buffer instanceof ArrayBuffer) {
    return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  }
  throw new TypeError('parseAgreementFile expects an ArrayBuffer or Uint8Array.');
}

/** Does this look like a ZIP archive (OOXML), whatever the extension says? */
function looksLikeZip(b) {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7);
}

/**
 * Parse an institutional agreement file into a normalized journal list.
 *
 * @param {ArrayBuffer|Uint8Array} arrayBuffer raw file bytes
 * @param {string} [filename] used for sourceName and format sniffing
 * @returns {Promise<{sourceName:string, publishers:string[], entries:object[], stats:object}>}
 */
export async function parseAgreementFile(arrayBuffer, filename = 'input') {
  const bytes = toBytes(arrayBuffer);
  const ext = (String(filename).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();

  if (looksLikeZip(bytes)) return parseOoxml(bytes, filename);
  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xlsb') {
    throw new Error(`"${filename}" has a spreadsheet extension but is not a ZIP/OOXML container.`);
  }
  return parseFlatFile(bytes, filename, ext);
}

/** Parse .csv / .tsv / .txt input. */
function parseFlatFile(bytes, filename, ext) {
  const text = decodeUtf8(bytes);
  const delimiter = ext === 'tsv' ? '\t' : detectDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  const publisher = String(filename).replace(/\.[^.]+$/, '') || 'input';
  const { entries, rows: dataRows, header } = extractEntries(rows, publisher);

  const withIssn = entries.reduce((n, e) => n + (e.issns.length ? 1 : 0), 0);
  const publishers = entries.length ? [...new Set(entries.map((e) => e.publisher))].sort() : [];
  return {
    sourceName: String(filename),
    publishers,
    entries,
    stats: {
      sheets: 1,
      rows: dataRows,
      entries: entries.length,
      withIssn,
      skippedSheets: header && entries.length ? [] : [publisher],
    },
  };
}

/** Parse an OOXML (.xlsx/.xlsm) workbook: one publisher per worksheet. */
async function parseOoxml(bytes, filename) {
  const zipEntries = readZipDirectory(bytes);

  const workbookPath = zipEntries.has('xl/workbook.xml')
    ? 'xl/workbook.xml'
    : [...zipEntries.keys()].find((n) => /(^|\/)workbook\.xml$/.test(n));
  if (!workbookPath) throw new Error(`"${filename}" is a ZIP but has no xl/workbook.xml.`);

  const relsPath = workbookPath.replace(/([^/]+)$/, '_rels/$1.rels');
  const [workbookXml, relsXml] = await Promise.all([
    readZipText(bytes, zipEntries, workbookPath),
    readZipText(bytes, zipEntries, relsPath),
  ]);

  const sheets = parseWorkbook(workbookXml);
  const rels = parseRels(relsXml);

  // Shared strings are a single large part: parse once, reuse for every sheet.
  const sharedPath = zipEntries.has('xl/sharedStrings.xml')
    ? 'xl/sharedStrings.xml'
    : [...zipEntries.keys()].find((n) => /(^|\/)sharedStrings\.xml$/.test(n));
  const sharedStrings = parseSharedStrings(
    sharedPath ? await readZipText(bytes, zipEntries, sharedPath) : ''
  );

  const entries = [];
  const publishers = [];
  const skippedSheets = [];
  const perSheet = [];
  let totalRows = 0;
  let sheetCount = 0;

  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    let path = sheet.rid ? rels.get(sheet.rid) : null;
    path = path ? resolveTarget(path, zipEntries) : null;
    if (!path) {
      // Fall back to positional worksheet naming.
      const guess = `xl/worksheets/sheet${i + 1}.xml`;
      path = zipEntries.has(guess) ? guess : null;
    }
    if (!path) {
      skippedSheets.push(sheet.name);
      continue;
    }
    sheetCount++;

    const xml = await readZipText(bytes, zipEntries, path);
    const rows = parseWorksheet(xml, sharedStrings);
    const res = extractEntries(rows, sheet.name);
    totalRows += res.rows;

    if (!res.entries.length) {
      skippedSheets.push(sheet.name);
      continue;
    }
    publishers.push(sheet.name);
    for (const e of res.entries) entries.push(e);
    perSheet.push({
      sheet: sheet.name,
      rows: res.rows,
      entries: res.entries.length,
      withIssn: res.entries.reduce((n, e) => n + (e.issns.length ? 1 : 0), 0),
      headerRow: res.headerRow + 1,
    });
  }

  const withIssn = entries.reduce((n, e) => n + (e.issns.length ? 1 : 0), 0);
  return {
    sourceName: String(filename),
    publishers,
    entries,
    stats: {
      sheets: sheetCount,
      rows: totalRows,
      entries: entries.length,
      withIssn,
      skippedSheets,
      // Extra detail, handy for UI and diagnostics; not part of the contract.
      perSheet,
    },
  };
}

/* ========================================================================== *
 * Public: index + lookup
 * ========================================================================== */

/**
 * Build ISSN and title indexes across one or more parsed files.
 * First writer wins, so pass files in priority order; for titles an entry
 * carrying an ISSN supersedes an earlier ISSN-less duplicate.
 *
 * @param {Array<{entries:object[]}>} parsedFiles
 * @returns {{byIssn:Map, byTitle:Map, count:number, publishers:string[]}}
 */
export function buildAgreementIndex(parsedFiles = []) {
  const byIssn = new Map();
  const byTitle = new Map();
  const publisherSet = new Set();
  let count = 0;

  const files = Array.isArray(parsedFiles) ? parsedFiles : [parsedFiles];
  for (const file of files) {
    if (!file || !Array.isArray(file.entries)) continue;
    for (const entry of file.entries) {
      count++;
      if (entry.publisher) publisherSet.add(entry.publisher);
      for (const issn of entry.issns || []) {
        if (!byIssn.has(issn)) byIssn.set(issn, entry);
      }
      const nt = entry.normTitle || normalizeTitle(entry.title);
      if (!nt) continue;
      const existing = byTitle.get(nt);
      const existingHasIssn = !!(existing && existing.issns && existing.issns.length);
      const hasIssn = !!(entry.issns && entry.issns.length);
      if (!existing || (!existingHasIssn && hasIssn)) byTitle.set(nt, entry);
    }
  }
  return { byIssn, byTitle, count, publishers: [...publisherSet].sort() };
}

/**
 * Look a journal up in an agreement index.
 * ISSN matches take priority; a normalized-title match is the fallback.
 *
 * @param {{byIssn:Map, byTitle:Map}} index
 * @param {{issns?:string[], title?:string}} query
 * @returns {object|null} the matching entry, or null
 */
export function lookupAgreement(index, { issns = [], title = '' } = {}) {
  if (!index || !index.byIssn) return null;

  const list = Array.isArray(issns) ? issns : [issns];
  for (const raw of list) {
    const n = normalizeIssn(raw);
    if (!n) continue;
    const hit = index.byIssn.get(n);
    if (hit) return hit;
  }
  const nt = normalizeTitle(title);
  if (nt && index.byTitle) {
    const hit = index.byTitle.get(nt);
    if (hit) return hit;
  }
  return null;
}
