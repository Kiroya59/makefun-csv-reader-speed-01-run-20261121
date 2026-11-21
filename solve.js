// Fast drop-in for csv-reader 1.0.0 (make.fun): run(input) returns exactly
// csv-reader's {columns, rows, errors} for {text, header}, but much faster.
//
// Semantics (same as the reference): a U+FEFF at the very start is dropped;
// a record ends at LF or CRLF and a line left with no characters is no
// record; outside quotes a CR not followed by LF is dropped (stray_cr); a
// field that opens with a quote runs to the next quote that is not doubled
// ("" inside is one quote, each CRLF or lone CR inside is read as LF); what
// follows its closing quote up to the next comma or line break is appended
// as it stands (quote_junk, when the field ends); a quote that never closes
// is a literal character and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is literal; fields
// stay strings, never trimmed or converted. columns is the first record
// when header is true, else null; rows are padded with "" (short_row) or cut
// (long_row) to the first record's width. Errors are {code, line, row} in
// the order met; line is the 1-based line the record starts on, counting
// every LF, CRLF and lone CR inside quotes; row is the record's index in
// rows, null for the header.
//
// Speed strategy: the input is scanned record by record with indexOf.
// A record whose line holds no quote at all is split in one native
// split(','). A record with quotes is parsed field by field with
// indexOf/slice, never character by character, as long as every quoted
// field closes on the same line and nothing in it needs repair. Only the
// rare broken records (a quoted field spanning lines, a stray CR, quote
// junk holding a CR, an unterminated quote) fall back to a general
// indexOf-driven parser that follows the reference step by step. The fast
// path never mutates the shared cursor until it has fully succeeded, so a
// fallback re-reads the record from exactly where it started.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. No dependencies, no WASM.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and its index in rows
  // (null for the header). The slow path reads these directly.
  let recLine = 1;
  let recRow = null;

  // A line break inside a quoted segment, normalised to one LF: CRLF and a
  // lone CR inside quotes are each one LF, and each one moves to a new line.
  function transformSeg(s) {
    if (s.indexOf('\r') === -1 && s.indexOf('\n') === -1) return s;
    const breaks = s.match(/\r\n?|\n/g);
    if (breaks !== null) line += breaks.length;
    return s.replace(/\r\n?|\n/g, '\n');
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the
  // field and how it ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      const ri = text.indexOf('\r', pos);
      let m = n;
      let kind = END;
      if (ci !== -1 && ci < m) { m = ci; kind = COMMA; }
      if (ni !== -1 && ni < m) { m = ni; kind = LINE_BREAK; }
      if (ri !== -1 && ri < m) { m = ri; kind = 3; }
      if (m > pos) {
        value += text.slice(pos, m);
        added += m - pos;
      }
      if (kind === END) {
        pos = n;
        return { value, ended: END, added };
      }
      if (kind === COMMA) {
        pos = m + 1;
        return { value, ended: COMMA, added };
      }
      if (kind === LINE_BREAK) {
        pos = m + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A lone CR: dropped, and the scan goes on from the next character.
      if (text.charCodeAt(m + 1) === 10) {
        pos = m + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      errors.push({ code: 'stray_cr', line: recLine, row: recRow });
      pos = m + 1;
    }
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    const parts = [];
    let segStart = pos;
    let closed = false;
    while (pos < n) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one literal quote, and the scan goes on.
        parts.push(transformSeg(text.slice(segStart, q)));
        parts.push('"');
        pos = q + 2;
        segStart = pos;
        continue;
      }
      parts.push(transformSeg(text.slice(segStart, q)));
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
      return readUnquoted('"');
    }
    const value = parts.join('');
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recLine, row: recRow });
    return junk;
  }

  // Reads one whole record the slow way (the reference's own loop, driven
  // by indexOf instead of one character at a time).
  function parseSlowRecord() {
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);
    return { fields, quoted };
  }

  // Tries to read the record starting at `start`, whose line (without its
  // terminating LF, and without a CRLF's CR) ends at `end`. Returns null
  // when the record needs the slow path (a quoted field that does not
  // close on this line, a stray CR, quote junk holding a CR). On success
  // returns the fields, whether the last field was quoted, how many lines
  // lone CRs inside quotes added, and how many quote_junk errors the
  // record holds; nothing is committed to the shared state here.
  function tryFast(start, end) {
    // No quote on the line at all: one native split does the whole record.
    // (A stray CR anywhere on the line bails to the slow path instead.)
    // The checks below are bounded indexOf scans, so a quoted line is
    // never copied just to be inspected: only a plain line is sliced,
    // once, for its split.
    const qi = text.indexOf('"', start);
    if (qi === -1 || qi >= end) {
      const ri = text.indexOf('\r', start);
      if (ri !== -1 && ri < end) return null;
      return { fields: text.slice(start, end).split(','), quoted: false, lineDelta: 0, junks: 0 };
    }
    // A quoted line falls through to the field loop, which bails to the
    // slow path if a CR turns up where it does not belong (a CR inside a
    // quoted field reads as LF and is handled in the loop).
    const fields = [];
    let junks = 0;
    let lineDelta = 0;
    let lastQuoted = false;
    let i = start;
    for (;;) {
      if (text.charCodeAt(i) === 34) {
        lastQuoted = true;
        // Find the closing quote: the next quote that is not doubled.
        let k = text.indexOf('"', i + 1);
        let close = -1;
        while (k !== -1 && k < end) {
          if (text.charCodeAt(k + 1) === 34) {
            k = text.indexOf('"', k + 2);
            continue;
          }
          close = k;
          break;
        }
        if (close === -1) return null;
        const raw = text.slice(i + 1, close);
        let val;
        if (raw.indexOf('"') === -1 && raw.indexOf('\r') === -1) {
          val = raw;
        } else {
          let c = 0;
          let p = raw.indexOf('\r');
          while (p !== -1) {
            c += 1;
            p = raw.indexOf('\r', p + 1);
          }
          lineDelta += c;
          val = raw.indexOf('\r') !== -1 ? raw.replaceAll('\r', '\n') : raw;
          if (raw.indexOf('"') !== -1) val = val.replaceAll('""', '"');
        }
        i = close + 1;
        if (i >= end) {
          fields.push(val);
          return { fields, quoted: lastQuoted, lineDelta, junks };
        }
        if (text.charCodeAt(i) === 44) {
          fields.push(val);
          i += 1;
          continue;
        }
        // Junk after the closing quote, up to the next comma or the line end.
        let j = text.indexOf(',', i);
        if (j === -1 || j > end) j = end;
        const junk = text.slice(i, j);
        if (junk.indexOf('\r') !== -1) return null;
        if (junk.length > 0) {
          junks += 1;
          val += junk;
        }
        fields.push(val);
        if (j >= end) return { fields, quoted: lastQuoted, lineDelta, junks };
        i = j + 1;
        continue;
      }
      lastQuoted = false;
      let j = text.indexOf(',', i);
      if (j === -1 || j > end) j = end;
      const f = text.slice(i, j);
      if (f.indexOf('\r') !== -1) return null;
      fields.push(f);
      if (j >= end) return { fields, quoted: lastQuoted, lineDelta, junks };
      i = j + 1;
    }
  }

  // Files the record just read: a line that held only stray CRs is left
  // with no characters and is no record (its stray_cr errors stay).
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text.charCodeAt(pos) === 10) {
        pos += 1;
        line += 1;
      } else if (text.charCodeAt(pos) === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? n : nl;
    let end = segEnd;
    // A CR right before the LF is the CRLF that ends the record.
    if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) end -= 1;

    const fast = tryFast(pos, end);
    if (fast !== null) {
      for (let k = 0; k < fast.junks; k += 1) {
        errors.push({ code: 'quote_junk', line: recLine, row: recRow });
      }
      line += fast.lineDelta;
      if (nl !== -1) {
        line += 1;
        pos = nl + 1;
      } else {
        pos = n;
      }
      finishRecord(fast.fields, fast.quoted);
      continue;
    }
    // The slow path re-reads the record from exactly where it started.
    const slow = parseSlowRecord();
    finishRecord(slow.fields, slow.quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
