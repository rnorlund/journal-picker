/**
 * test-agreements.mjs — run with: node test/test-agreements.mjs
 *
 * Exercises src/agreements.js against the real USC open-access agreement
 * workbook plus synthetic fixtures for the CSV/TSV and STORED-ZIP paths.
 *
 * node:fs is used here only to load the test files from disk; the module under
 * test receives plain ArrayBuffers and imports nothing.
 */

import { readFileSync, existsSync } from 'node:fs';

import {
  parseAgreementFile,
  normalizeTitle,
  normalizeIssn,
  buildAgreementIndex,
  lookupAgreement,
} from '../src/agreements.js';

const XLSM_PRIMARY = AGREEMENT_FILE;
const XLSM_SECONDARY = '';

/* -------------------------------------------------------------------------- *
 * Tiny assertion harness
 * -------------------------------------------------------------------------- */

let passed = 0;
const failures = [];

function ok(cond, label, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(actual, expected, label) {
  ok(
    actual === expected,
    label,
    actual === expected ? '' : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
  );
}

function section(name) {
  console.log(`\n${name}`);
}

/** Read a file as a standalone ArrayBuffer, the way a browser File would. */
function readArrayBuffer(path) {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** UTF-8 encode a string into an ArrayBuffer. */
function textBuffer(s) {
  return new TextEncoder().encode(s).buffer;
}

/* -------------------------------------------------------------------------- *
 * Environment sanity: no DOMParser in Node, so the XML reader must not need it
 * -------------------------------------------------------------------------- */

section('Environment');
ok(typeof DOMParser === 'undefined', 'DOMParser is absent in Node (module cannot depend on it)');
ok(typeof DecompressionStream === 'function', 'native DecompressionStream is available');

/* -------------------------------------------------------------------------- *
 * normalizeIssn
 * -------------------------------------------------------------------------- */

section('normalizeIssn');
eq(normalizeIssn('1601-5215'), '1601-5215', "'1601-5215' round-trips");
eq(normalizeIssn('16015215'), '1601-5215', "'16015215' gains its hyphen");
eq(normalizeIssn('  1601-5215  '), '1601-5215', 'surrounding whitespace tolerated');
eq(normalizeIssn('ISSN: 1601-5215'), '1601-5215', 'label prefix stripped');
eq(normalizeIssn('Web Only'), null, "'Web Only' rejected");
eq(normalizeIssn('Web Only '), null, "'Web Only ' (trailing space) rejected");
eq(normalizeIssn('n/a'), null, "'n/a' rejected");
eq(normalizeIssn(''), null, 'empty string rejected');
eq(normalizeIssn('   '), null, 'whitespace-only rejected');
eq(normalizeIssn(null), null, 'null rejected');
eq(normalizeIssn('yyyy-yyyy'), null, "junk 'yyyy-yyyy' rejected");
eq(normalizeIssn('0000-0000'), null, "'0000-0000' rejected (not a real ISSN)");
eq(normalizeIssn('1234-5678'), null, 'bad checksum rejected');
eq(normalizeIssn('1433-299X'), '1433-299X', "real X check digit validates ('1433-299X')");
eq(normalizeIssn('1433299x'), '1433-299X', 'lowercase x normalized to uppercase');
eq(normalizeIssn('0093-934X'), '0093-934X', "second X-terminated ISSN validates ('0093-934X')");
eq(normalizeIssn('1053-8119'), '1053-8119', 'NeuroImage ISSN validates');
eq(normalizeIssn('1053-811X'), null, 'wrong check digit on a real prefix rejected');
eq(normalizeIssn('93934X'), '0093-934X', 'lost leading zeros recovered when checksum agrees');

/* -------------------------------------------------------------------------- *
 * normalizeTitle
 * -------------------------------------------------------------------------- */

section('normalizeTitle');
eq(normalizeTitle('NeuroImage'), 'neuroimage', 'lowercased');
eq(normalizeTitle('The Lancet'), 'lancet', "leading 'The ' stripped");
eq(normalizeTitle('Brain & Behavior'), 'brain and behavior', "'&' becomes 'and'");
eq(
  normalizeTitle('Gynécologie Obstétrique Fertilité & Sénologie'),
  'gynecologie obstetrique fertilite and senologie',
  'diacritics stripped'
);
eq(
  normalizeTitle('Journal of Neuro-Oncology, Part B.'),
  'journal of neuro oncology part b',
  'punctuation removed and whitespace collapsed'
);
eq(normalizeTitle('  Acta   Numerica  '), 'acta numerica', 'runs of whitespace collapsed');
eq(normalizeTitle('Kinésithérapie, la Revue'), 'kinesitherapie la revue', 'accented comma title');
eq(normalizeTitle(null), '', 'null yields empty string');
eq(normalizeTitle(123), '123', 'non-strings coerced');
ok(
  normalizeTitle('The NeuroImage') === normalizeTitle('NeuroImage'),
  'article-only difference collapses to one key'
);

/* -------------------------------------------------------------------------- *
 * CSV / TSV
 * -------------------------------------------------------------------------- */

section('CSV / TSV parsing');

const csv = [
  'Journal Title,Print ISSN,Electronic ISSN,URL,Publishing Model',
  'NeuroImage,1053-8119,1095-9572,https://www.sciencedirect.com/journal/neuroimage,Hybrid',
  '"Journal of ""Applied"" Physics, Part B",0093-934X,,https://example.org/japb,Pure OA',
  'Placeholder Journal,Web Only,n/a,,Subscribe to Open',
  '"Multi ISSN Journal","1601-5215; 1474-0508",,,Hybrid',
].join('\r\n');

const csvParsed = await parseAgreementFile(textBuffer(csv), 'elsevier-sample.csv');
eq(csvParsed.stats.entries, 4, 'CSV yields 4 entries');
eq(csvParsed.stats.rows, 4, 'CSV counted 4 data rows');
eq(csvParsed.sourceName, 'elsevier-sample.csv', 'sourceName echoes the filename');

const csvNeuro = csvParsed.entries[0];
eq(csvNeuro.title, 'NeuroImage', 'CSV title parsed');
eq(csvNeuro.issns.join(','), '1053-8119,1095-9572', 'both print and electronic ISSNs collected');
eq(csvNeuro.model, 'Hybrid', 'Publishing Model column read');
eq(
  csvNeuro.url,
  'https://www.sciencedirect.com/journal/neuroimage',
  'URL column read'
);

const csvQuoted = csvParsed.entries[1];
eq(
  csvQuoted.title,
  'Journal of "Applied" Physics, Part B',
  'quoted field with comma and doubled quotes'
);
eq(csvQuoted.issns.join(','), '0093-934X', 'X-terminated ISSN kept, empty column ignored');
eq(csvQuoted.model, 'Pure OA', "model 'Pure OA'");

const csvPlaceholder = csvParsed.entries[2];
eq(csvPlaceholder.issns.length, 0, "'Web Only' and 'n/a' produce no ISSNs");
eq(csvPlaceholder.model, 'Subscribe to Open', "model 'Subscribe to Open'");
eq(csvPlaceholder.url, null, 'empty URL becomes null');

eq(
  csvParsed.entries[3].issns.join(','),
  '1601-5215,1474-0508',
  'semicolon-separated multi-ISSN cell split'
);

const tsv = [
  'Journal Acronym\tJournal/Conference Name\teISSN',
  'NIMG\tNeuroImage\t1053-8119',
  'ACTA\tActa Numerica\t1474-0508',
].join('\n');
const tsvParsed = await parseAgreementFile(textBuffer(tsv), 'acronyms.tsv');
eq(tsvParsed.stats.entries, 2, 'TSV yields 2 entries');
eq(tsvParsed.entries[0].title, 'NeuroImage', 'acronym column is not mistaken for the title');
eq(tsvParsed.entries[1].title, 'Acta Numerica', 'second TSV row title');

/* -------------------------------------------------------------------------- *
 * STORED (method 0) ZIP entries
 * -------------------------------------------------------------------------- */

section('OOXML with STORED (method 0) entries');

/** Build a minimal ZIP whose entries are all stored uncompressed. */
function buildStoredZip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const lfh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lfh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(8, 0, true); // method 0 = STORED
    dv.setUint32(14, 0, true); // crc32 (unused by the reader)
    dv.setUint32(18, data.length, true); // compressed size
    dv.setUint32(22, data.length, true); // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    lfh.set(nameBytes, 30);
    locals.push(lfh, data);

    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); // method 0
    cv.setUint32(16, 0, true); // crc32
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cdh.set(nameBytes, 46);
    centrals.push(cdh);

    offset += lfh.length + data.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, eocd];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

const storedZip = buildStoredZip([
  [
    'xl/workbook.xml',
    '<?xml version="1.0"?><workbook xmlns:r="http://x"><sheets>' +
      '<sheet r:id="rId1" name="Intro" sheetId="1"/>' +
      '<sheet name="Tiny Press" r:id="rId2" sheetId="2"/>' +
      '</sheets></workbook>',
  ],
  [
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships>' +
      '<Relationship Target="worksheets/sheet1.xml" Id="rId1" Type="t"/>' +
      '<Relationship Id="rId2" Type="t" Target="/xl/worksheets/sheet2.xml"/>' +
      '</Relationships>',
  ],
  [
    'xl/sharedStrings.xml',
    '<?xml version="1.0"?><sst count="4" uniqueCount="4">' +
      '<si><t>Journal Title</t></si>' +
      '<si><t xml:space="preserve">Rich </t><t>Runs</t><rPh sb="0" eb="1"><t>IGNORED</t></rPh><t xml:space="preserve"> Journal</t></si>' +
      '<si><t>Caf&#233; &amp; Society</t></si>' +
      '<si/>' +
      '</sst>',
  ],
  ['xl/worksheets/sheet1.xml', '<worksheet><sheetData/></worksheet>'],
  [
    'xl/worksheets/sheet2.xml',
    '<worksheet><sheetData>' +
      // Header on row 3, with an empty leading column and gaps.
      '<row r="1"/>' +
      '<row r="2"><c r="B2" t="inlineStr"><is><t>Some prose, no header here</t></is></c></row>' +
      '<row r="3"><c r="B3" t="s"><v>0</v></c><c r="D3" t="inlineStr"><is><t>Electronic ISSN</t></is></c>' +
      '<c r="E3" t="inlineStr"><is><t>Publishing Model</t></is></c></row>' +
      // Shared string title; note the skipped column C.
      '<row r="4"><c r="B4" t="s"><v>1</v></c><c r="D4" t="str"><f>A1</f><v>1601-5215</v></c>' +
      '<c r="E4" t="inlineStr"><is><t>Hybrid</t></is></c></row>' +
      // Entity-decoded shared string; numeric ISSN that lost its leading zeros.
      '<row r="5"><c r="B5" t="s"><v>2</v></c><c r="D5"><v>68993</v></c></row>' +
      // Empty shared string title -> skipped entirely.
      '<row r="6"><c r="B6" t="s"><v>3</v></c><c r="D6" t="inlineStr"><is><t>Web Only</t></is></c></row>' +
      '</sheetData></worksheet>',
  ],
]);

const stored = await parseAgreementFile(storedZip, 'tiny.xlsx');
eq(stored.stats.sheets, 2, 'both worksheets were located via rels');
eq(stored.publishers.join(','), 'Tiny Press', 'only the sheet with data is reported');
eq(stored.stats.skippedSheets.join(','), 'Intro', 'header-less sheet is skipped');
eq(stored.stats.entries, 2, 'two usable rows');
eq(stored.entries[0].title, 'Rich Runs Journal', 'multiple <t> runs joined, rPh ignored');
eq(stored.entries[0].issns.join(','), '1601-5215', 'formula-cached string value read');
eq(stored.entries[0].model, 'Hybrid', 'model column read from the row-3 header');
eq(stored.entries[1].title, 'Café & Society', 'numeric and named entities decoded');
eq(stored.entries[1].normTitle, 'cafe and society', 'entity-decoded title normalizes');
eq(stored.entries[1].issns.join(','), '0006-8993', 'numeric ISSN cell recovered');

/* -------------------------------------------------------------------------- *
 * The real workbook
 * -------------------------------------------------------------------------- */

section('Real workbook: uscoo.xlsm');

if (!existsSync(XLSM_PRIMARY)) {
  failures.push(`missing test file ${XLSM_PRIMARY}`);
  console.log(`  FAIL  test file not found: ${XLSM_PRIMARY}`);
} else {
  const ab = readArrayBuffer(XLSM_PRIMARY);
  const t0 = performance.now();
  const wb = await parseAgreementFile(ab, 'uscoo.xlsm');
  const elapsedMs = performance.now() - t0;

  console.log(
    `\n  parsed ${(ab.byteLength / 1024).toFixed(0)} KB in ${elapsedMs.toFixed(0)} ms ` +
      `-> ${wb.stats.entries} entries\n`
  );

  // ---- per-sheet table -----------------------------------------------------
  const bySheet = new Map();
  for (const e of wb.entries) {
    const row = bySheet.get(e.publisher) || { entries: 0, withIssn: 0, withUrl: 0 };
    row.entries++;
    if (e.issns.length) row.withIssn++;
    if (e.url) row.withUrl++;
    bySheet.set(e.publisher, row);
  }
  const table = wb.publishers.map((p) => ({
    sheet: p,
    entries: bySheet.get(p).entries,
    withIssn: bySheet.get(p).withIssn,
    withUrl: bySheet.get(p).withUrl,
  }));
  console.table(table);
  console.log(`  skipped sheets: ${JSON.stringify(wb.stats.skippedSheets)}`);
  console.log(
    `  totals: sheets=${wb.stats.sheets} rows=${wb.stats.rows} ` +
      `entries=${wb.stats.entries} withIssn=${wb.stats.withIssn}\n`
  );

  // ---- scale ---------------------------------------------------------------
  ok(wb.stats.entries >= 7000, 'at least 7000 entries', `got ${wb.stats.entries}`);
  ok(wb.stats.withIssn >= 6000, 'at least 6000 entries with a valid ISSN', `got ${wb.stats.withIssn}`);
  ok(elapsedMs < 10000, 'parse completed in under 10s', `took ${elapsedMs.toFixed(0)} ms`);
  eq(wb.sourceName, 'uscoo.xlsm', 'sourceName is the filename');
  eq(wb.stats.sheets, 16, 'all 16 worksheets were read');
  eq(wb.stats.skippedSheets.join(','), 'Introduction', 'only the prose Introduction sheet skipped');
  eq(wb.publishers.length, 15, '15 sheets yielded entries');
  ok(
    wb.stats.rows >= wb.stats.entries && wb.stats.rows < 9000,
    'row count is in the expected ~8.6k range',
    `rows=${wb.stats.rows}`
  );
  ok(
    wb.entries.every((e) => typeof e.title === 'string' && e.title.length > 0),
    'every entry has a non-empty title'
  );
  ok(
    wb.entries.every((e) => e.normTitle === normalizeTitle(e.title)),
    'normTitle is consistent with normalizeTitle for every entry'
  );
  ok(
    wb.entries.every((e) => e.issns.every((i) => normalizeIssn(i) === i)),
    'every stored ISSN is already normalized and valid'
  );

  // ---- known rows ----------------------------------------------------------
  const find = (norm) => wb.entries.filter((e) => e.normTitle === norm);

  const acta = find('acta neuropsychiatrica');
  eq(acta.length, 1, "'Acta Neuropsychiatrica' appears exactly once");
  eq(acta[0]?.publisher, 'Cambridge', "'Acta Neuropsychiatrica' comes from Cambridge");
  eq(acta[0]?.issns.join(','), '1601-5215', "'Acta Neuropsychiatrica' ISSN is 1601-5215");
  eq(acta[0]?.title, 'Acta Neuropsychiatrica', 'title preserved verbatim');

  const plos = wb.entries.filter((e) => e.publisher === 'PLOS');
  ok(plos.length >= 6 && plos.length <= 9, 'PLOS sheet has ~8 entries', `got ${plos.length}`);
  ok(
    plos.every((e) => /^PLOS /.test(e.title) && e.issns.length === 1 && e.url),
    'every PLOS entry has a PLOS title, one eISSN and a URL'
  );
  ok(
    plos.some((e) => e.normTitle === 'plos one' && e.issns[0] === '1932-6203'),
    'PLOS ONE present with eISSN 1932-6203'
  );

  // The Elsevier sheet is the workbook's largest journal list. NOTE: this
  // workbook's Elsevier tab covers only the ~1.6k titles in the USC agreement
  // and genuinely does NOT include NeuroImage (verified: the string never
  // occurs anywhere in the workbook, including the shared string table), so a
  // real-file NeuroImage assertion is replaced by an equivalent Elsevier
  // neuroscience anchor. The NeuroImage lookup path is covered below using the
  // CSV fixture.
  const elsevier = wb.entries.filter((e) => e.publisher === 'Elsevier');
  ok(elsevier.length > 1500, 'Elsevier sheet yields >1500 entries', `got ${elsevier.length}`);
  ok(
    !wb.entries.some((e) => /neuroimage/i.test(e.title)),
    'NeuroImage is confirmed absent from this workbook (not in the USC agreement)'
  );
  const brainRes = elsevier.filter((e) => e.normTitle === 'brain research');
  eq(brainRes.length, 1, "Elsevier sheet contains 'Brain Research'");
  eq(brainRes[0]?.issns.join(','), '0006-8993', "'Brain Research' ISSN is 0006-8993");
  ok(
    elsevier.some((e) => e.normTitle === 'brain and language' && e.issns[0] === '0093-934X'),
    "Elsevier 'Brain and Language' carries the X-terminated ISSN 0093-934X"
  );
  ok(
    elsevier.some((e) => e.title === 'Gynécologie Obstétrique Fertilité & Sénologie'),
    'accented Elsevier title read without mangling'
  );

  // Acronym columns must not be mistaken for titles.
  const acmProc = wb.entries.filter((e) => e.publisher === 'ACM Proceedings');
  ok(acmProc.length > 400, 'ACM Proceedings sheet yields >400 entries', `got ${acmProc.length}`);
  ok(
    acmProc.some(
      (e) =>
        e.title ===
        'International Conference on Algorithms, Computing and Artificial Intelligence'
    ),
    'ACM Proceedings title taken from the Title column, not the acronym column'
  );
  ok(
    !acmProc.some((e) => e.title === 'ACAI'),
    'no ACM Proceedings entry is just an acronym'
  );

  // The ACS sheet carries two ISSN columns (Electronic + Print); its
  // print-less titles hold the literal 'Web Only', which must be discarded
  // while the electronic ISSN survives.
  const acs = wb.entries.filter((e) => e.publisher === 'ACS');
  ok(acs.length > 50, 'ACS sheet yields >50 entries', `got ${acs.length}`);
  ok(
    acs.some((e) => e.issns.length === 2),
    'ACS titles with both ISSNs collect two ISSNs'
  );
  ok(
    acs.some((e) => e.issns.length === 1),
    "ACS titles whose Print ISSN reads 'Web Only' keep only the electronic ISSN"
  );
  const amr = acs.find((e) => e.normTitle === 'accounts of materials research');
  eq(amr?.issns.join(','), '2643-6728', "'Web Only' dropped from Accounts of Materials Research");
  ok(
    !wb.entries.some((e) => e.issns.some((i) => /only|n\/a|^-+$/i.test(i))),
    'no placeholder text ever reaches an issns array'
  );

  // De Gruyter is the one sheet carrying Publishing Model / Product Type.
  const degruyter = wb.entries.filter((e) => e.publisher === 'De Gruyter');
  ok(degruyter.length > 400, 'De Gruyter sheet yields >400 entries', `got ${degruyter.length}`);
  const models = new Set(degruyter.map((e) => e.model).filter(Boolean));
  ok(models.size > 0, 'De Gruyter Publishing Model column was detected', `models=${[...models]}`);
  const expectedModels = [
    'Hybrid',
    'Partner title',
    'Pure OA',
    'Read only',
    'Sponsored OA',
    'Subscribe to Open',
  ];
  eq(
    [...models].sort().join('|'),
    expectedModels.join('|'),
    'De Gruyter model values match the sheet verbatim'
  );
  ok(
    degruyter.some((e) => e.model === 'Subscribe to Open'),
    "at least one De Gruyter title is 'Subscribe to Open'"
  );

  // ---- index + lookup ------------------------------------------------------
  section('buildAgreementIndex / lookupAgreement');
  const index = buildAgreementIndex([wb]);
  eq(index.count, wb.stats.entries, 'index counted every entry');
  eq(index.publishers.length, 15, 'index lists 15 publishers');
  ok(index.byIssn.size > 6000, 'ISSN index holds >6000 keys', `got ${index.byIssn.size}`);
  ok(index.byTitle.size > 6000, 'title index holds >6000 keys', `got ${index.byTitle.size}`);

  const byIssnHit = lookupAgreement(index, { issns: ['1601-5215'] });
  eq(byIssnHit?.title, 'Acta Neuropsychiatrica', 'ISSN lookup finds Acta Neuropsychiatrica');
  eq(
    lookupAgreement(index, { issns: ['16015215'] })?.title,
    'Acta Neuropsychiatrica',
    'un-hyphenated ISSN lookup works'
  );
  eq(
    lookupAgreement(index, { title: 'acta neuropsychiatrica' })?.publisher,
    'Cambridge',
    'title lookup is case-insensitive'
  );
  eq(
    lookupAgreement(index, { title: 'The Brain Research' })?.issns.join(','),
    '0006-8993',
    "title lookup ignores a leading 'The'"
  );
  eq(lookupAgreement(index, { issns: ['1053-8119'] }), null, 'NeuroImage is not in this agreement');
  eq(lookupAgreement(index, { issns: ['Web Only'], title: '' }), null, 'junk ISSN yields no match');
  eq(lookupAgreement(index, {}), null, 'empty query yields no match');
  eq(lookupAgreement(null, { issns: ['1601-5215'] }), null, 'missing index yields no match');

  // ISSN must win over a conflicting title.
  const priority = lookupAgreement(index, {
    issns: ['1601-5215'],
    title: 'PLOS ONE',
  });
  eq(priority?.title, 'Acta Neuropsychiatrica', 'ISSN match takes priority over title match');

  // ---- multi-file index ----------------------------------------------------
  const multi = buildAgreementIndex([wb, csvParsed]);
  eq(multi.count, wb.stats.entries + csvParsed.stats.entries, 'multi-file index counted both files');
  const neuro = lookupAgreement(multi, { issns: ['1053-8119'] });
  eq(neuro?.title, 'NeuroImage', 'NeuroImage found by ISSN 1053-8119 in the merged index');
  eq(neuro?.publisher, 'elsevier-sample', 'NeuroImage entry carries its source publisher');
  eq(
    lookupAgreement(multi, { title: 'NeuroImage' })?.issns.join(','),
    '1053-8119,1095-9572',
    'NeuroImage also found by title'
  );
  eq(
    lookupAgreement(multi, { issns: ['1095-9572'] })?.title,
    'NeuroImage',
    'NeuroImage found by its secondary (electronic) ISSN'
  );
  eq(
    lookupAgreement(multi, { issns: ['0000-0000'], title: 'neuroimage' })?.title,
    'NeuroImage',
    'invalid ISSN falls through to the title match'
  );

  // ---- second copy of the workbook ----------------------------------------
  section('Real workbook: USC Open Access Pub list.xlsm');
  if (!existsSync(XLSM_SECONDARY)) {
    failures.push(`missing test file ${XLSM_SECONDARY}`);
    console.log(`  FAIL  test file not found: ${XLSM_SECONDARY}`);
  } else {
    const t1 = performance.now();
    const wb2 = await parseAgreementFile(
      readArrayBuffer(XLSM_SECONDARY),
      'USC Open Access Pub list.xlsm'
    );
    const ms2 = performance.now() - t1;
    console.log(`  parsed in ${ms2.toFixed(0)} ms -> ${wb2.stats.entries} entries`);
    ok(wb2.stats.entries >= 7000, 'second workbook also yields >=7000 entries');
    ok(wb2.stats.withIssn >= 6000, 'second workbook also yields >=6000 ISSNs');
    eq(wb2.sourceName, 'USC Open Access Pub list.xlsm', 'second workbook sourceName');
    eq(
      wb2.publishers.join('|'),
      wb.publishers.join('|'),
      'both workbook copies expose the same publisher list'
    );
    eq(wb2.stats.entries, wb.stats.entries, 'both workbook copies yield identical entry counts');
    ok(ms2 < 10000, 'second workbook parsed in under 10s', `took ${ms2.toFixed(0)} ms`);
  }
}

/* -------------------------------------------------------------------------- *
 * Error handling
 * -------------------------------------------------------------------------- */

section('Error handling');
let threw = null;
try {
  await parseAgreementFile(textBuffer('not a spreadsheet at all'), 'broken.xlsx');
} catch (err) {
  threw = err;
}
ok(threw instanceof Error, 'non-ZIP data with an .xlsx name throws a clear error');

threw = null;
try {
  await parseAgreementFile('a string', 'x.csv');
} catch (err) {
  threw = err;
}
ok(threw instanceof TypeError, 'non-buffer input throws a TypeError');

const emptyCsv = await parseAgreementFile(textBuffer('just,some,noise\n1,2,3\n'), 'noise.csv');
eq(emptyCsv.stats.entries, 0, 'a table with no title column yields no entries');
eq(emptyCsv.stats.skippedSheets.length, 1, 'unusable flat file is reported as skipped');

// Uint8Array input must work as well as ArrayBuffer.
const asU8 = await parseAgreementFile(
  new Uint8Array(new TextEncoder().encode('Title,ISSN\nActa Numerica,1474-0508\n')),
  'u8.csv'
);
eq(asU8.stats.entries, 1, 'Uint8Array input accepted');
eq(asU8.entries[0].issns.join(','), '1474-0508', 'Uint8Array input parsed correctly');

/* -------------------------------------------------------------------------- *
 * Summary
 * -------------------------------------------------------------------------- */

console.log(`\n${'='.repeat(64)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} ASSERTIONS PASSED`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('='.repeat(64));
process.exit(failures.length === 0 ? 0 : 1);
