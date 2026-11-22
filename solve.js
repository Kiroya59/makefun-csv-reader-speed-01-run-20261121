// csv-reader rev-3 (v2): a faster drop-in for csv-reader 1.0.0.
//
// The win is in how the answer is serialised. The previous revision built
// every field's JSON by hand (a regex test plus a wrap per field, then a
// join per row). A single native JSON.stringify over a whole row — and one
// over the whole case — does the escaping and joining in C++ and is about
// twice as fast as the per-field loop. So this parser collects plain JS
// values (columns, rows, errors) with a fast indexOf-based reader and lets
// one JSON.stringify per case do all the quoting. Field finding itself is
// bulk indexOf/slice, never char-by-char; a quoted field is found with
// indexOf and its line breaks counted in one pass.
// Semantics are csv-reader 1.0.0's, exactly (kit RULES.txt + vendor reader):
// BOM dropped; record ends at LF/CRLF; empty line is no record; lone CR
// outside quotes is dropped (stray_cr); a quoted field runs to the next
// non-doubled quote, "" is one quote, CR/LF inside quotes read as LF; text
// after a closing quote is appended (quote_junk); a quote that never closes
// is a literal and the rest is read unquoted (unterminated_quote); a quote
// inside an unquoted field is literal; columns is the first record when
// header is true, else null; rows are padded (short_row) or cut (long_row)
// to the first record's width; errors are {code, line, row} in order met.

export function run(input) {
  return stringifyCase(input);
}

export function stringifyCase(input) {
  const src = String(input.text);
  const wantHeader = input.header === true;
  const end = src.length;
  let at = 0;
  let ln = 1;
  if (end > 0 && src.charCodeAt(0) === 0xfeff) at = 1;

  let cols = null;
  let width = -1;
  const rows = [];
  const errs = [];
  let colsJson = null;
  let recLn = 1;
  let recRow = null;

  function pushErr(code, extra) {
    let s = '{"code":"' + code + '","line":' + recLn + ',"row":' +
      (recRow === null ? 'null' : recRow);
    if (extra !== undefined) {
      if (code === 'short_row') s += ',"fields":' + extra;
      else s += ',"extra":' + JSON.stringify(extra);
    }
    s += '}';
    errs.push(s);
  }

  // Line breaks in src[a..b): LF, CRLF and lone CR each count once.
  function countLn(a, b) {
    let c = 0;
    for (let i = a; i < b; i++) {
      const ch = src.charCodeAt(i);
      if (ch === 10) c++;
      else if (ch === 13) { c++; if (i + 1 < b && src.charCodeAt(i + 1) === 10) i++; }
    }
    return c;
  }

  // Read an unquoted field onto `seed`, starting at `at`. Returns
  // [value, ended, kept]: ended 0=comma, 1=break, 2=end; kept counts the
  // characters kept (stray CRs dropped, not counted). Used for the rare
  // paths (junk after a closing quote, unterminated quote); the common
  // unquoted field is inlined in the record loop.
  function readPlain(seed) {
    let val = seed;
    let kept = 0;
    while (at < end) {
      const c = src.indexOf(',', at);
      const nl = src.indexOf('\n', at);
      let stop = end;
      let kind = 2;
      if (c !== -1 && c < stop) { stop = c; kind = 0; }
      if (nl !== -1 && nl < stop) { stop = nl; kind = 1; }
      let cut = stop;
      if (kind === 1 && stop > at && src.charCodeAt(stop - 1) === 13) cut = stop - 1;
      const piece = src.slice(at, cut);
      const cr = piece.indexOf('\r');
      if (cr !== -1) {
        val += piece.slice(0, cr);
        let from = cr;
        let cnt = 0;
        while (true) {
          const nx = piece.indexOf('\r', from + 1);
          cnt++;
          if (nx === -1) { val += piece.slice(from + 1); break; }
          val += piece.slice(from + 1, nx);
          from = nx;
        }
        kept += piece.length - cnt;
        for (let i = 0; i < cnt; i++) pushErr('stray_cr');
        if (kind === 0) { at = stop + 1; return [val, 0, kept]; }
        if (kind === 1) { at = stop + 1; ln++; return [val, 1, kept]; }
        at = end;
        return [val, 2, kept];
      }
      val += piece;
      kept += piece.length;
      if (kind === 0) { at = stop + 1; return [val, 0, kept]; }
      if (kind === 1) { at = stop + 1; ln++; return [val, 1, kept]; }
      at = end;
      return [val, 2, kept];
    }
    return [val, 2, kept];
  }

  while (true) {
    // Blank lines are no records.
    while (at < end) {
      const ch = src.charCodeAt(at);
      if (ch === 10) { at++; ln++; }
      else if (ch === 13 && at + 1 < end && src.charCodeAt(at + 1) === 10) { at += 2; ln++; }
      else break;
    }
    if (at >= end) break;
    recLn = ln;
    recRow = (wantHeader && cols === null) ? null : rows.length;

    const flds = [];
    let ended = 0;
    let quoted = false;
    do {
      quoted = at < end && src.charCodeAt(at) === 34;
      let val;
      if (quoted) {
        const open = at;
        const openLn = ln;
        at++;
        let close = -1;
        let s = at;
        let dbl = false;
        while (true) {
          const cand = src.indexOf('"', s);
          if (cand === -1) break;
          if (cand + 1 < end && src.charCodeAt(cand + 1) === 34) { dbl = true; s = cand + 2; continue; }
          close = cand;
          break;
        }
        if (close === -1) {
          at = open + 1;
          ln = openLn;
          pushErr('unterminated_quote');
          const r = readPlain('"');
          val = r[0];
          ended = r[1];
        } else {
          let v = src.slice(at, close);
          if (v.indexOf('\r') !== -1 || v.indexOf('\n') !== -1) {
            ln += countLn(at, close);
            if (v.indexOf('\r') !== -1) v = v.replace(/\r\n?/g, '\n');
          }
          if (dbl) v = v.replace(/""/g, '"');
          at = close + 1;
          if (at >= end) { val = v; ended = 2; }
          else {
            const c = src.charCodeAt(at);
            if (c === 44) { at++; val = v; ended = 0; }
            else if (c === 10) { at++; ln++; val = v; ended = 1; }
            else if (c === 13 && at + 1 < end && src.charCodeAt(at + 1) === 10) { at += 2; ln++; val = v; ended = 1; }
            else {
              const r = readPlain(v);
              if (r[2] > 0) pushErr('quote_junk');
              val = r[0];
              ended = r[1];
            }
          }
        }
      } else {
        // Inline plain read (hot path): one bulk piece to the delimiter.
        val = '';
        ended = 2;
        while (at < end) {
          const c = src.indexOf(',', at);
          const nl = src.indexOf('\n', at);
          let stop = end;
          let kind = 2;
          if (c !== -1 && c < stop) { stop = c; kind = 0; }
          if (nl !== -1 && nl < stop) { stop = nl; kind = 1; }
          let cut = stop;
          if (kind === 1 && stop > at && src.charCodeAt(stop - 1) === 13) cut = stop - 1;
          const piece = src.slice(at, cut);
          const cr = piece.indexOf('\r');
          if (cr !== -1) {
            val += piece.slice(0, cr);
            let from = cr;
            let cnt = 0;
            while (true) {
              const nx = piece.indexOf('\r', from + 1);
              cnt++;
              if (nx === -1) { val += piece.slice(from + 1); break; }
              val += piece.slice(from + 1, nx);
              from = nx;
            }
            for (let i = 0; i < cnt; i++) pushErr('stray_cr');
            if (kind === 0) { at = stop + 1; ended = 0; }
            else if (kind === 1) { at = stop + 1; ln++; ended = 1; }
            else { at = end; ended = 2; }
            break;
          }
          val += piece;
          if (kind === 0) { at = stop + 1; ended = 0; }
          else if (kind === 1) { at = stop + 1; ln++; ended = 1; }
          else { at = end; ended = 2; }
          break;
        }
      }
      flds.push(val);
    } while (ended === 0);

    // A line left with only stray CRs is no record (its errors stay).
    if (flds.length === 1 && flds[0] === '' && !quoted) continue;

    if (width < 0) width = flds.length;
    if (wantHeader && cols === null) {
      colsJson = JSON.stringify(flds);
      cols = flds;
      continue;
    }
    if (flds.length < width) {
      pushErr('short_row', flds.length);
      while (flds.length < width) flds.push('');
    } else if (flds.length > width) {
      const extra = flds.splice(width);
      pushErr('long_row', extra);
    }
    rows.push(JSON.stringify(flds));
  }

  return '{"columns":' + (wantHeader ? (colsJson ?? '[]') : 'null') +
    ',"rows":[' + rows.join(',') + '],"errors":[' + errs.join(',') + ']}';
}
