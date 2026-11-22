// Fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01-run-20261121).
// Same answers as the reference on every input, but (a) reads the text with bulk
// indexOf/slice operations instead of one character at a time, and (b) emits the
// answer JSON directly while parsing, so no second serialisation pass is needed.
// The field-end search uses only ',' and '\n' (a CRLF is found through its LF);
// a lone CR is caught by scanning just the short field slice, never the rest of
// the text. Semantics mirror vendor/csv-reader/index.js exactly (see RULES.txt).
// run(input) returns the JSON text of {columns, rows, errors}; main.ts joins the
// per-case texts into answers.json.

const COMMA = 0;      // field ended at a comma
const LINE_BREAK = 1; // field ended at a line break
const END = 2;        // field ended at the end of the text

// JSON-quote a string. Most field values need no escaping at all.
const NEED_ESC = /["\\\u0000-\u001f]/;
function q(s) {
  return NEED_ESC.test(s) ? JSON.stringify(s) : '"' + s + '"';
}

export function run(input) {
  return readCsvJson(input);
}

export function readCsvJson(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let colJson = null;      // JSON of columns, once the first record is read
  let width = -1;
  const rowJsons = [];     // each element is one row's JSON, e.g. ["a","b"]
  const errJsons = [];     // each element is one error's JSON
  let rowCount = 0;

  let recordLine = 1;
  let recordRow = null;

  // error(code) for stray_cr / quote_junk / unterminated_quote (no extra fields)
  const err = (code) => {
    errJsons.push('{"code":"' + code + '","line":' + recordLine + ',"row":' +
      (recordRow === null ? 'null' : recordRow) + '}');
  };

  // Count line breaks in text[a..b): each LF, each CRLF and each lone CR counts once.
  const countBreaks = (a, b) => {
    let c = 0;
    for (let i = a; i < b; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 10) c++;
      else if (ch === 13) { c++; if (i + 1 < b && text.charCodeAt(i + 1) === 10) i++; }
    }
    return c;
  };

  // Read an unquoted field starting at pos, with `value` already built.
  // Returns {value, ended}. Mirrors reference readUnquoted, but jumps with indexOf.
  // Only ',' and '\n' are searched globally; a CR-LF is found through its LF,
  // and a lone CR is caught by scanning just the short field slice.
  function readUnquoted(value) {
    while (pos < n) {
      const c = text.indexOf(',', pos);
      const nl = text.indexOf('\n', pos);
      let end = n;
      let kind = END;
      if (c !== -1 && c < end) { end = c; kind = COMMA; }
      if (nl !== -1 && nl < end) { end = nl; kind = LINE_BREAK; }
      // Field text is [pos,end); a CR right before a LF is the CRLF half.
      let stop = end;
      if (kind === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13) stop = end - 1;
      // A lone CR inside the field text is a stray CR: drop it, record, continue.
      // (A CRLF is already handled: its LF is the `end` we found.)
      const seg = text.slice(pos, stop);
      const crAt = seg.indexOf('\r');
      if (crAt !== -1) {
        // one or more stray CRs in this segment; drop them all, one error each.
        value += seg.slice(0, crAt);
        let from = crAt;
        let count = 0;
        while (true) {
          const nx = seg.indexOf('\r', from + 1);
          count += 1;
          if (nx === -1) { value += seg.slice(from + 1); break; }
          value += seg.slice(from + 1, nx);
          from = nx;
        }
        for (let i = 0; i < count; i++) err('stray_cr');
        pos = end;
        // continue the field after the dropped CRs, up to the delimiter at `end`
        if (kind === COMMA) { pos = end + 1; return { value, ended: COMMA }; }
        if (kind === LINE_BREAK) { pos = end + 1; line += 1; return { value, ended: LINE_BREAK }; }
        pos = n;
        return { value, ended: END };
      }
      value += seg;
      if (kind === COMMA) { pos = end + 1; return { value, ended: COMMA }; }
      if (kind === LINE_BREAK) { pos = end + 1; line += 1; return { value, ended: LINE_BREAK }; }
      pos = n;
      return { value, ended: END };
    }
    return { value, ended: END };
  }

  // Read a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    // Find the closing quote: a '"' not followed by another '"'.
    let q = -1;
    let search = pos;
    let doubled = false;
    while (true) {
      const cand = text.indexOf('"', search);
      if (cand === -1) { q = -1; break; }
      if (cand + 1 < n && text.charCodeAt(cand + 1) === 34) {
        doubled = true;
        search = cand + 2;
        continue;
      }
      q = cand;
      break;
    }
    if (q === -1) {
      // never closes: the quote is a literal, text after it read again as unquoted.
      pos = open + 1;
      line = openLine;
      err('unterminated_quote');
      return readUnquoted('"');
    }
    // raw content between the quotes
    let value = text.slice(pos, q);
    // line breaks inside quotes each count once; CRLF / lone CR read as LF.
    if (value.indexOf('\r') !== -1 || value.indexOf('\n') !== -1) {
      line += countBreaks(pos, q);
      if (value.indexOf('\r') !== -1) value = value.replace(/\r\n?/g, '\n');
    }
    if (doubled) value = value.replace(/""/g, '"');
    pos = q + 1;
    if (pos >= n) return { value, ended: END };
    const ch = text.charCodeAt(pos);
    if (ch === 44) { pos += 1; return { value, ended: COMMA }; } // ,
    if (ch === 10) { pos += 1; line += 1; return { value, ended: LINE_BREAK }; } // \n
    if (ch === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2; line += 1; return { value, ended: LINE_BREAK }; // \r\n
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.value.length > value.length) err('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const ch = text.charCodeAt(pos);
      if (ch === 10) { pos += 1; line += 1; }
      else if (ch === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && colJson === null ? null : rowCount;
    const fields = []; // field values as JS strings
    let field;
    let quoted;
    do {
      quoted = pos < n && text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && colJson === null) {
      colJson = '[' + fields.map(q).join(',') + ']';
      continue;
    }
    if (fields.length < width) {
      errJsons.push('{"code":"short_row","line":' + recordLine + ',"row":' +
        (recordRow === null ? 'null' : recordRow) + ',"fields":' + fields.length + '}');
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      const extra = fields.splice(width);
      errJsons.push('{"code":"long_row","line":' + recordLine + ',"row":' +
        (recordRow === null ? 'null' : recordRow) + ',"extra":[' +
        extra.map(q).join(',') + ']}');
    }
    rowJsons.push('[' + fields.map(q).join(',') + ']');
    rowCount += 1;
  }

  const cols = header ? (colJson ?? '[]') : 'null';
  return '{"columns":' + cols + ',"rows":[' + rowJsons.join(',') +
    '],"errors":[' + errJsons.join(',') + ']}';
}
