'use strict';

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------
//
// Reading a statement is six stages, each consuming what the one before it
// concluded. None of them can be understood on its own, because every bug
// found here so far has been a stage drawing the wrong conclusion about the
// whole file from one anomalous row.
//
//   decode          bytes    -> text        sniffs UTF-8 vs Big5
//   parseCsv        text     -> grid        quotes, CRLF, drops blank lines
//   detectHeaderRow grid     -> row number  only when the client sent none
//   bodyWidth       grid     -> width       how many columns the file uses
//   extractRows     grid     -> rows        repairRagged, parse, errors
//   checkBalanceChain rows   -> warnings    inDateOrder, then prev + amount
//
// What each stage may assume of the one before it, and what it owes the one
// after — the parts that are not obvious from the signature:
//
//   detectHeaderRow  Must not see a trailing empty cell as a missing column:
//                    a trailing delimiter is on most real exports. Never runs
//                    when the client supplied headerRow; the user's answer
//                    always wins.
//
//   bodyWidth        Decides for the WHOLE file, so it may only conclude from
//                    what most rows agree on. One anomalous row must never
//                    change the width, because every other row is then
//                    measured against it.
//
//   repairRagged     Operates on ONE row and may not consider any other. It
//                    folds overflow into the description, so it needs that
//                    column; without one the row must be refused, not guessed.
//
//   extractRows      A row whose shape it could not trust carries `ragged`,
//                    and a row carrying any error gets a null fingerprint —
//                    markDuplicates derives status from the fingerprint, so a
//                    row that keeps one imports no matter what else is wrong.
//                    The one thing that holds back a well-formed row is
//                    `pending`: the bank has not finished writing it yet.
//
//   checkBalanceChain  Every cell of a `ragged` row came from a shifted
//                    position, the balance included, so it may not anchor on
//                    one. A row with no amount but an intact shape (an
//                    opening-balance line) may. Warnings only: a file that
//                    legitimately starts mid-history breaks at its first row.
//
// The invariant that ties them together, and the one both bugs broke: **a
// bad row is local**. One row being wide, shifted or refused may change how
// that row is reported and nothing else about any other row. `test/
// api.test.js` asserts it over every bank fixture by injecting an extra field
// at each position in turn, in both the repairable and the unrepairable case.
// Adding a bank means adding its fixture to `BANK_FIXTURES`; the combinations
// come for free, which is the point — each of these bugs passed every test
// its own stage had.
//
// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

// Taiwanese online banking still exports Big5 more often than not, and Excel
// on Windows writes UTF-8 with a BOM. Both have to just work.

(function (root) {
  const { sha1Hex } = typeof module !== 'undefined' && module.exports ? require('./sha1') : root;

  function decode(buf, encoding = 'auto') {
    if (encoding === 'auto') encoding = sniffEncoding(buf);
    let text = new TextDecoder(encoding, { fatal: false }).decode(buf);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { text, encoding };
  }

  function sniffEncoding(buf) {
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
    const strict = new TextDecoder('utf-8', { fatal: true });
    try {
      strict.decode(buf);
      return 'utf-8';
    } catch {
      return 'big5';
    }
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  function parseCsv(text, delimiter = ',') {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += c;
        continue;
      }
      if (c === '"') { quoted = true; continue; }
      if (c === delimiter) { row.push(field); field = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }

    return rows
      .map((r) => r.map((f) => f.trim()))
      .filter((r) => r.some((f) => f !== ''));
  }

  function sniffDelimiter(text) {
    const head = text.split('\n').slice(0, 5).join('\n');
    const counts = [',', '\t', ';', '|'].map((d) => [d, head.split(d).length]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 1 ? counts[0][0] : ',';
  }

  // ---------------------------------------------------------------------------
  // Dates
  // ---------------------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');

  // A 民國 year is three digits in anything exported this century — 民國 100 was
  // 2011 — and only that form is safe to read without having been told.
  // `09/13/26` from a Capital One 360 Checking export fits the same slashed
  // shape exactly: read as ROC it is refused outright on the rows whose day is
  // over twelve (民國 9 年 13 月), and on every other row it becomes a perfectly
  // plausible 1920-08-26 that nothing downstream would question. Several rows
  // of such a file land in 1920 that way, and the derived opening balance
  // goes with them.
  //
  // So `auto` takes the unambiguous form only, and a genuine two-digit ROC year
  // stays reachable by choosing 民國 in the import form. guessMapping's own
  // sniff calls this rather than repeating the pattern, so the format the
  // mapping reports and the format parseDate applies cannot drift apart.
  const ROC_SLASHED = /^(\d{3})[/-](\d{1,2})[/-](\d{1,2})$/;
  function looksRoc(value) {
    const m = ROC_SLASHED.exec(String(value ?? '').trim());
    return !!m && Number(m[1]) < 200;
  }

  // Handles ROC years (114/09/20, 1140920), ISO, slashed, and US month-first in
  // both its four- and two-digit-year spellings (09/20/2026, 09/13/26).
  function parseDate(raw, format = 'auto') {
    if (!raw) return null;
    const s = String(raw).trim().replace(/[年月]/g, '/').replace(/日/g, '');
    let m;

    if (format === 'roc' || format === 'auto') {
      if ((m = s.match(/^(\d{2,3})[/-](\d{1,2})[/-](\d{1,2})$/))) {
        if (format === 'roc' || looksRoc(s)) return iso(Number(m[1]) + 1911, m[2], m[3]);
      }
      if ((m = s.match(/^(\d{3})(\d{2})(\d{2})$/))) return iso(Number(m[1]) + 1911, m[2], m[3]);
    }

    if (format === 'ymd' || format === 'auto') {
      if ((m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/))) return iso(m[1], m[2], m[3]);
      if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return iso(m[1], m[2], m[3]);
    }

    if (format === 'mdy' || format === 'auto') {
      if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/))) return iso(m[3], m[1], m[2]);
      // Two digits is this century. These are bank statements, not birth
      // records, and the alternative reading — 1926 — is not one any export
      // means. Anchored at both ends so it cannot swallow a ROC date.
      if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/))) return iso(2000 + Number(m[3]), m[1], m[2]);
    }

    if (format === 'dmy') {
      if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/))) return iso(m[3], m[2], m[1]);
    }

    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  function iso(y, mo, d) {
    const Y = Number(y), M = Number(mo), D = Number(d);
    if (!Y || M < 1 || M > 12 || D < 1 || D > 31) return null;
    return `${Y}-${pad(M)}-${pad(D)}`;
  }

  // ---------------------------------------------------------------------------
  // Amounts
  // ---------------------------------------------------------------------------

  function parseAmount(raw) {
    if (raw === null || raw === undefined) return null;
    let s = String(raw).trim();
    if (!s || s === '-' || s === '--') return null;

    let sign = 1;
    if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }     // (1,234) => -1234
    s = s.replace(/[$NT＄,，\s]/g, '').replace(/元/g, '');
    if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
    if (s.startsWith('+')) s = s.slice(1);
    if (!s || !/^\d*\.?\d+$/.test(s)) return null;

    const n = Number(s);
    return Number.isFinite(n) ? round2(sign * n) : null;
  }

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  // ---------------------------------------------------------------------------
  // Mapping
  // ---------------------------------------------------------------------------

  const HINTS = {
    // Posting beats transaction date on purpose. A Chase card export carries
    // both and they disagree on most rows, so the choice is not cosmetic —
    // and it cannot be revisited, because the date is part of the fingerprint
    // and a card export has no reference number to fall back on. Switching
    // later re-imports the whole file. Posting date is the one the statement
    // balance is computed on, the one a deposit account exports, and the one
    // that puts a card payment in the same three-day window as its counterpart
    // in checking. This ledger reconciles first, so it wins.
    // Every issuer spells it differently — Chase writes `Post Date`, Capital One
    // writes `Posted Date`, and neither reads as the other — so each spelling
    // has to be listed. A missing one is not a failure to map: the column falls
    // through to `date`, `Transaction Date` outscores it, and the file imports
    // against the wrong date with nothing to show for it. Capital One's two
    // disagree on most rows too.
    date: ['交易日期', '帳務日期', '入帳日期', '消費日期', '日期', '交易日', 'posting date', 'post date', 'posted date', 'transaction date', 'date', 'trade date'],
    out: ['支出金額', '提出金額', '轉出金額', '支出', '提出', '轉出', '借方金額', '借方', 'debit', 'withdrawal', 'withdrawals', 'money out', 'paid out'],
    in: ['存入金額', '轉入金額', '收入金額', '存入', '轉入', '收入', '貸方金額', '貸方', 'credit', 'deposit', 'deposits', 'money in', 'paid in'],
    // Some statements leave the amount unsigned and put the direction in a
    // column of its own: Capital One's 360 Checking writes `Credit` or `Debit`
    // beside an always-positive `Transaction Amount`. Naming such a column is
    // not enough to identify one — Chase heads its Sale/Payment/Return column
    // `Type` too — so guessMapping reads the cells before believing the header.
    type: ['交易類型', '交易別', '借貸別', '收支別', '收支', 'transaction type', 'debit/credit', 'dr/cr', 'type'],
    amount: ['交易金額', '金額', '發生金額', 'amount', 'transaction amount', 'value'],
    desc: ['摘要', '說明', '交易說明', '備註', '註記', '對方戶名', '商店名稱', '交易類別', 'description', 'payee', 'name', 'memo', 'details', 'merchant'],
    externalId: ['交易序號', '序號', 'reference', 'transaction id', 'fitid', 'id'],
    balance: ['餘額', '帳戶餘額', '結存', '本日餘額', 'running bal.', 'running balance', 'balance', 'ending balance'],
    // Not `type`: a Chase card names its Sale/Payment/Return column that, which
    // is what the row is, not what it was spent on.
    category: ['消費類別', '類別', '分類', '交易類別', 'category'],
    // Citi writes `Cleared` or `Pending` here. Only the pending words are ever
    // read out of it (see isPending), so matching a column that turns out to
    // mean something else costs nothing.
    status: ['狀態', 'status'],
  };

  const norm = (s) => String(s || '').toLowerCase().replace(/[\s_\-()（）]/g, '');

  function matchHint(header, list) {
    const h = norm(header);
    if (!h) return 0;
    for (let i = 0; i < list.length; i++) {
      const k = norm(list[i]);
      if (h === k) return 100 - i;
      if (h.includes(k) || k.includes(h)) return 60 - i;
    }
    return 0;
  }

  function bestColumn(headers, list, exclude = []) {
    let best = null, bestScore = 0;
    headers.forEach((h, i) => {
      if (exclude.includes(i)) return;
      const s = matchHint(h, list);
      if (s > bestScore) { bestScore = s; best = i; }
    });
    return bestScore > 0 ? best : null;
  }

  // Mapping a header row is one pass of "take the best remaining column", and
  // **the order of the calls is the precedence** — a column claimed early is
  // gone for everything after it, which is how a file whose 摘要 column would
  // also match `category` keeps it as the summary.
  //
  // Spelled out, that precedence was nine hand-copied exclusion arrays, each
  // one entry longer than the last, so adding a tenth kind of column meant
  // editing nine call sites correctly. It had already gone wrong once without
  // anyone noticing: `typeCol` and `statusCol` were written by different
  // changes and ended up carrying the *same* list, so neither excluded the
  // other and a header matching both hint lists (`Type Status`) was claimed
  // twice and read under two different rules. Harmless in that instance, and
  // not reachable from any real statement here, but it is the failure the
  // copying invites and the next column would repeat it.
  //
  // So the accumulator is kept in one place: call in precedence order and
  // exclusion takes care of itself.
  function columnPicker(headers) {
    const taken = [];
    return (list) => {
      const i = bestColumn(headers, list, taken);
      if (i !== null) taken.push(i);
      return i;
    };
  }

  // The sign of an unsigned amount, read out of a direction column. The
  // vocabulary is the one already written down for debit/credit HEADERS: a
  // column that says `Debit` in every cell is making the same statement as a
  // column headed `Debit`, so there is no second list to keep in step.
  //
  // Exact match, never substring. `ACH_CREDIT` and `LOAN_PMT` are the values in
  // Chase's `Type` column — they are what the transaction was, not which way it
  // went — and reading `credit` out of the first while the second says nothing
  // would sign half a file by accident and leave the other half refused.
  // 0 rather than null for "cannot tell", so callers can just test it.
  function direction(value) {
    const v = norm(value);
    if (!v) return 0;
    if (HINTS.out.some((k) => norm(k) === v)) return -1;
    if (HINTS.in.some((k) => norm(k) === v)) return 1;
    return 0;
  }

  // Whether a column genuinely states the direction of the amounts beside it,
  // which only its cells can answer — never its header. Chase heads its
  // Sale/Payment/Return column `Type` as well, and choosing this mode on the
  // header alone would refuse every row of a checking export, all of which
  // parse today.
  //
  // Decided over the whole file rather than on one row, at the same 90%
  // bodyWidth uses: a column naming a direction on nearly every row is one, and
  // a blank or a footer does not unmake it.
  //
  // Deliberately NOT also requiring the amounts to be unsigned. It reads like a
  // free extra check — a file that signs its own amounts has already said which
  // way each row goes — but it fails towards the silent answer: one stray
  // negative in an otherwise unsigned file would drop the whole thing back to
  // `single`, where every withdrawal imports as income and only the running
  // balance objects. A signed file needs no protection here anyway, because
  // extractRows takes the magnitude absolutely, so a row that states its
  // direction twice cannot come out negated twice.
  function directionColumn(rows, typeCol, amountCol) {
    let read = 0, unread = 0;
    for (const r of rows) {
      // No amount means a footer or a blank line, not a vote.
      if (parseAmount(r[amountCol]) === null) continue;
      if (direction(r[typeCol])) read++;
      else unread++;
    }
    return read > 0 && read >= (read + unread) * 0.9;
  }

  // Plenty of statements do not start with the header row: Bank of America opens
  // with a five-line summary block, Taiwanese exports often prepend the account
  // number and the query range. Take the first fully populated row that names
  // both a date and a money column — the one pairing no data row ever has.
  // A trailing comma leaves an empty last cell on a great many real exports, so
  // judge a candidate by its populated span rather than its raw length —
  // otherwise `Date,Amount,Balance,` is rejected and detection silently falls
  // back to row 1.
  const dropTrailingEmpty = (row) => {
    let end = row.length;
    while (end > 0 && !String(row[end - 1] || '').trim()) end--;
    return row.slice(0, end);
  };

  function detectHeaderRow(grid, limit = 20) {
    for (let i = 0; i < Math.min(grid.length, limit); i++) {
      const row = dropTrailingEmpty(grid[i]);
      if (row.length < 2 || row.some((c) => !String(c || '').trim())) continue;
      const hasDate = bestColumn(row, HINTS.date) !== null;
      const hasMoney =
        bestColumn(row, HINTS.amount) !== null ||
        bestColumn(row, HINTS.out) !== null ||
        bestColumn(row, HINTS.in) !== null;
      if (hasDate && hasMoney) return i + 1;
    }
    return 1;
  }

  // Best-effort first guess; the UI always shows it for confirmation.
  function guessMapping(headers, rows) {
    // Precedence order — see columnPicker. Each line takes from what is left.
    const pick = columnPicker(headers);
    const dateCol = pick(HINTS.date);
    const outCol = pick(HINTS.out);
    const inCol = pick(HINTS.in);
    const amountCol = pick(HINTS.amount);
    const balanceCol = pick(HINTS.balance);
    // After the description, so a column literally named 摘要 stays the summary
    // and only a genuine category column is read as one.
    const descCol = pick(HINTS.desc);
    const externalIdCol = pick(HINTS.externalId);
    const categoryCol = pick(HINTS.category);
    // Last of the unconditional ones, so a column only becomes the status
    // column when nothing that actually carries a number wanted it.
    const statusCol = pick(HINTS.status);

    // Two-column debit/credit is the Taiwanese bank default; a single signed
    // amount column is the US default. Prefer whichever the file actually has.
    const hasInOut = outCol !== null && inCol !== null;

    // The third shape: one unsigned amount column, with the direction beside it.
    // Picked after everything else so it can only take a column nobody else
    // wanted, and confirmed against the cells rather than the header — see
    // directionColumn. Not picked at all when the file already answers the
    // question, so it cannot consume a column in a file that has no use for it.
    const typeCol = hasInOut || amountCol === null ? null : pick(HINTS.type);
    const typed = typeCol !== null && directionColumn(rows, typeCol, amountCol);

    let dateFormat = 'auto';
    if (dateCol !== null && rows.length) {
      const sample = rows.slice(0, 20).map((r) => r[dateCol]).filter(Boolean);
      if (sample.some(looksRoc)) dateFormat = 'roc';
    }

    return {
      encoding: 'auto',
      delimiter: ',',
      headerRow: 1,
      dateCol,
      dateFormat,
      amountMode: hasInOut ? 'inout' : typed ? 'typed' : 'single',
      amountCol,
      outCol,
      inCol,
      // Only when it earned the mode. A column we decided is not a direction
      // column has no business sitting in the mapping as if it were.
      typeCol: typed ? typeCol : null,
      balanceCol,
      descCols: descCol === null ? [] : [descCol],
      externalIdCol,
      categoryCol,
      statusCol,
      invert: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Row extraction
  // ---------------------------------------------------------------------------

  function fingerprint(accountId, date, amount, description) {
    const desc = String(description || '').toLowerCase().replace(/[\s,.\-_/\\()（）【】「」*#]/g, '');
    // `sha1Hex` from shared/sha1.js rather than node:crypto, which exists only
    // in Node — and whose browser counterpart is async, which this loop is not.
    // Byte-identical by test, because every fingerprint already in a ledger was
    // computed the old way and the dedup contract says the definition may not
    // change without migrating them all.
    return sha1Hex(`${accountId}|${date}|${round2(amount).toFixed(2)}|${desc}`);
  }

  // Bank of America writes a raw `"` inside an already-quoted description
  // (`for "may recital"`) instead of doubling it. Most of the time the stray
  // quotes pair up and the row still lands in the right columns; when the phrase
  // between them contains a comma, the row splits into extra columns and every
  // field after the description shifts left — the amount silently becomes
  // whatever fragment lands in its slot. The overflow is always inside the one
  // free-text column, so fold the extras back into it and let the caller decide
  // whether to trust the result.
  function repairRagged(row, width, descCol, delimiter = ',') {
    const extra = row.length - width;
    if (extra <= 0 || descCol === null || descCol === undefined) return null;
    if (descCol + extra >= row.length) return null;
    // Rejoin with the character the split actually consumed. A comma gets its
    // space back because parseCsv trims each field; anything else goes back
    // verbatim, so a tab-separated description does not acquire commas it
    // never had.
    const glue = delimiter === ',' ? ', ' : delimiter;
    return [
      ...row.slice(0, descCol),
      row.slice(descCol, descCol + extra + 1).join(glue),
      ...row.slice(descCol + extra + 1),
    ];
  }

  // How many columns the file actually uses, which is not always how many the
  // header names. Chase writes a trailing delimiter past the last column on
  // every row of a checking export, so a 7-column header sits above a body that
  // is uniformly 8 fields wide. Measured against the header, every row looks
  // shifted: repairRagged folds the amount into the description and every row
  // is refused, with the error pointing at the amount column rather than at
  // the stray comma.
  //
  // Widen to what the body agrees on — but only when the columns past the header
  // are empty in every row that has them. Content past the last named column is
  // data the header failed to mention, not padding, and must stay ragged.
  //
  // "Agrees on" has to mean the width most rows share, not the narrowest wide
  // row. A padded file with one genuinely shifted row in it has two wide widths,
  // and taking the minimum picks the padding width while the shifted row still
  // carries content in the padding slot — so the paddedness check fails, the
  // whole file falls back to the header width, and then every row repairs:
  // the amount column reads the balance, the balance reads null, and the chain
  // that would have caught it is skipped because there is no balance left to
  // chain. Plausible numbers, no error, which is the failure this whole path
  // exists to prevent. The mode keeps that to the one row that is actually
  // shifted.
  function bodyWidth(headers, body) {
    const width = headers.length;
    const wider = body.filter((r) => r.length > width);
    // A handful of wide rows is a handful of shifted rows; a whole file of them
    // is how the file is written.
    if (!wider.length || wider.length < body.length * 0.9) return width;

    // The mode, not the minimum. Padding is uniform, so it is whatever most of
    // the wide rows are; a row wider than that is one shifted row, and letting
    // it drag the width down is what sent the whole file back to the header.
    // Ties go to the narrower width, which leaves the difference visible as a
    // repair rather than swallowing it.
    const counts = new Map();
    for (const r of wider) counts.set(r.length, (counts.get(r.length) || 0) + 1);
    const common = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];

    // Judge paddedness on the rows at that width only: a wider row is a shift,
    // and its content past the header is exactly what must stay ragged.
    const padded = wider
      .filter((r) => r.length === common)
      .every((r) => r.slice(width, common).every((c) => !String(c ?? '').trim()));
    return padded ? common : width;
  }

  // A row the bank has not finished writing. Citi's "current view" export
  // carries a Status column and fills it with `Cleared` or `Pending`, and a
  // pending row is provisional in all three of the fields the fingerprint is
  // made of: the amount moves when a tip or a hold settles, the date becomes
  // the posting date, and the merchant string is rewritten. Import one and the
  // posted row arrives in the next download as a second transaction for the
  // same purchase — with no reference number on a card export to catch it.
  //
  // Only a word that positively means "not final yet" holds a row back.
  // Statements otherwise say Cleared, Posted, Completed, 已入帳 or nothing at
  // all, and refusing every word that is not on a list would refuse whole files
  // over a column nobody reads. **An unrecognised status is a final status**:
  // this check may cost an import a row, never let one through that would
  // otherwise have been refused.
  const PENDING_WORDS = ['pending', '未入帳', '處理中'];

  function isPending(raw) {
    const s = norm(raw);
    return !!s && PENDING_WORDS.some((w) => s.includes(norm(w)));
  }

  // One cell of a row, by a column index out of the mapping. A mapping index
  // is `null` when the user picked nothing and `undefined` when the mapping was
  // saved before that column existed — a real case, because saved mappings
  // outlive the code that wrote them — so every read has to tolerate both.
  // Written out at each site that was the same two comparisons six times, and
  // the two spellings had already drifted: the `single` branch tested only for
  // null. Returning undefined for an unset column is what the readers below
  // already want, since parseAmount, direction and isPending all treat it as
  // "nothing here".
  const cell = (row, col) => (col === null || col === undefined ? undefined : row[col]);

  function extractRows(rows, mapping, accountId) {
    const headerIdx = Math.max(0, (mapping.headerRow || 1) - 1);
    const headers = rows[headerIdx] || [];
    const body = rows.slice(headerIdx + 1);
    const width = bodyWidth(headers, body);
    const descCol = (mapping.descCols || [])[0];
    const out = [];

    body.forEach((raw, i) => {
      const lineNo = headerIdx + 2 + i;

      let r = raw;
      let repaired = false;
      if (width > 1 && r.length > width) {
        const fixed = repairRagged(r, width, descCol, mapping.delimiter || ',');
        if (fixed) { r = fixed; repaired = true; }
      }

      const rawDate = mapping.dateCol === null ? '' : r[mapping.dateCol];
      const date = parseDate(rawDate, mapping.dateFormat || 'auto');

      let amount = null;
      // Set only in `typed` mode, and only when the magnitude read but the
      // direction did not — the one case where there is a number on the row and
      // still no amount. Kept apart from `amount === null` so the row can say
      // which cell it choked on.
      let unreadableDirection = null;
      // Two columns, and **the column is the direction — the sign inside the
      // cell is ignored on purpose**. Citi is why that has to be spelled out:
      // under one identical `Status,Date,Description,Debit,Credit` header its
      // deposit export writes a credit positive (`,,900.00,`) and its card
      // export writes one negative (`,,-3200.00`). Reading the sign would turn
      // every card payment back into a charge; reading the column gets both
      // files right with the same mapping. test/fixtures/citi-card-2025.csv and
      // -2026.csv are a card's whole life, and they only add up to zero this
      // way round. `typed` below takes the magnitude absolutely for the same
      // reason, from the one column it has.
      if (mapping.amountMode === 'inout') {
        const outV = parseAmount(cell(r, mapping.outCol));
        const inV = parseAmount(cell(r, mapping.inCol));
        if (outV !== null && outV !== 0) amount = -Math.abs(outV);
        else if (inV !== null && inV !== 0) amount = Math.abs(inV);
      } else if (mapping.amountMode === 'typed') {
        // The amount column holds a magnitude and the type column holds the
        // sign; neither is a transaction on its own. Take the magnitude
        // absolutely, so a file that signs its amounts AND labels them cannot
        // come out negated twice.
        const mag = parseAmount(cell(r, mapping.amountCol));
        const dir = direction(cell(r, mapping.typeCol));
        if (mag !== null && dir) amount = dir * Math.abs(mag);
        // A magnitude with no direction is the dangerous half of this mode:
        // refuse it rather than pick a sign. `Withdrawal from ...` for 12.58
        // imports just as cleanly as +12.58 as it does as -12.58.
        else if (mag !== null) unreadableDirection = String(cell(r, mapping.typeCol) ?? '').trim();
      } else {
        amount = parseAmount(cell(r, mapping.amountCol));
      }
      if (amount !== null && mapping.invert) amount = -amount;

      const description = (mapping.descCols || [])
        .map((c) => r[c])
        .filter((v) => v && String(v).trim())
        .join(' / ')
        .trim();

      const externalId = String(cell(r, mapping.externalIdCol) || '').trim() || null;

      // Deliberately not part of the fingerprint: a bank recategorising a row
      // between two exports must not turn it into a new transaction.
      const category = String(cell(r, mapping.categoryCol) || '').trim();

      const balance = parseAmount(cell(r, mapping.balanceCol));

      // Not an error — the row parsed perfectly, it just is not finished yet.
      // markDuplicates turns this into its own status so it can be skipped for
      // the reason it is actually being skipped.
      const pending = isPending(cell(r, mapping.statusCol));

      const errors = [];
      // A row that does not line up with the header did not parse the way the
      // file meant it, so every column index in it is suspect. Refuse it rather
      // than guess: a shifted row still carries a plausible date and a plausible
      // number, so it would import as a real transaction with the wrong amount
      // and nothing on screen would say so.
      // Carried as a flag as well as a message: checkBalanceChain has to tell a
      // structurally broken row from a legitimate balance-only anchor line, and
      // matching on the message text would break the moment it is reworded.
      const ragged = width > 1 && r.length !== width;
      if (ragged) {
        errors.push(`欄位數不符：標題列有 ${width} 欄，這行是 ${r.length} 欄`);
      }
      if (!date) errors.push(`日期無法解析：「${rawDate || ''}」`);
      if (unreadableDirection !== null) {
        // Empty covers both a blank cell and a mapping with no direction column
        // chosen yet — quoting nothing at the user explains neither.
        errors.push(unreadableDirection
          ? `收支別無法判讀：「${unreadableDirection}」，看不出這行是進還是出`
          : '收支別是空的，看不出這行是進還是出');
      } else if (amount === null) errors.push('金額無法解析或為零');

      out.push({
        lineNo,
        date,
        amount,
        balance,
        repaired,
        ragged,
        pending,
        description,
        category,
        externalId,
        raw: r,
        errors,
        fingerprint: errors.length ? null : fingerprint(accountId, date, amount, description),
      });
    });

    checkBalanceChain(out);
    return { headers, rows: out };
  }

  // A statement that carries a running balance can check itself: each row's
  // balance has to be the one above it plus this row's amount. A break means a
  // row was dropped, mangled, or repaired into the wrong shape — none of which
  // the amounts alone can show. It is a warning rather than an error: a file
  // that legitimately starts mid-history breaks the chain at its first row, and
  // refusing those rows would be worse than flagging them.
  // A running balance only chains in date order, and statements disagree about
  // which way they list: Bank of America's checking export runs oldest first,
  // Chase's runs newest first. Walking a newest-first file forwards makes every
  // single row but the first look like a break, which buries a genuine gap
  // in noise. Decide from the rows themselves rather than
  // from a per-bank setting, so an unlabelled file still checks itself.
  function inDateOrder(rows) {
    const dated = rows.filter((r) => r.date);
    let up = 0, down = 0;
    for (let i = 1; i < dated.length; i++) {
      if (dated[i].date > dated[i - 1].date) up++;
      else if (dated[i].date < dated[i - 1].date) down++;
    }
    return down > up ? [...rows].reverse() : rows;
  }

  function checkBalanceChain(allRows) {
    const rows = inDateOrder(allRows);
    let prev = null;
    for (const row of rows) {
      if (row.balance === null) { prev = null; continue; }
      // A ragged row is suspect in every column, this one included: the cell
      // sitting in the balance slot is whatever the shift left there, and a
      // fragment like `118` parses as cleanly as a real balance. Chaining onto
      // it reports a drift computed from that fragment, so the next good row
      // gets flagged with a number and a cause that are both wrong. Break the
      // chain instead — we genuinely do not know the balance here.
      if (row.ragged) { prev = null; continue; }
      // A balance-only anchor line such as BoA's "Beginning balance as of ..."
      // has no amount but is otherwise intact, so its balance is true and
      // re-anchors the chain rather than breaking it.
      if (row.amount === null || row.errors.length) { prev = row.balance; continue; }
      if (prev !== null) {
        const drift = round2(row.balance - round2(prev + row.amount));
        if (Math.abs(drift) >= 0.005) row.balanceBreak = drift;
      }
      prev = row.balance;
    }
    // The flags land on the row objects themselves, so hand back the caller's
    // own ordering rather than the one this walk happened to need.
    return allRows;
  }

  // Rows already in the DB win; within one file, identical rows are counted so
  // two genuinely separate same-day same-amount entries both survive.
  function markDuplicates(extracted, existingCounts) {
    const seen = new Map();
    for (const row of extracted) {
      if (!row.fingerprint) { row.status = 'error'; continue; }
      // Before the dedup, not after: a pending row never imports, so it must
      // not consume one of the duplicate slots either. Counted here, a file
      // carrying both the pending row and the posted one it became would mark
      // the posted row a duplicate of a row that was never written.
      if (row.pending) { row.status = 'pending'; continue; }
      if (row.externalId && existingCounts.externalIds.has(row.externalId)) {
        row.status = 'duplicate';
        row.dupReason = '交易序號已存在';
        continue;
      }
      const n = seen.get(row.fingerprint) || 0;
      const have = existingCounts.fingerprints.get(row.fingerprint) || 0;
      seen.set(row.fingerprint, n + 1);
      if (n < have) {
        row.status = 'duplicate';
        row.dupReason = '同帳戶已有相同日期／金額／摘要';
      } else {
        row.status = 'new';
      }
    }
    return extracted;
  }

  // ---------------------------------------------------------------------------
  // What a statement says about the account it came from
  // ---------------------------------------------------------------------------

  // Importing needs an account, and creating one needs numbers the user would
  // otherwise have to go and look up. Most of them are already in the file.
  //
  // Everything here is a *suggestion*: it is shown in an editable form and
  // nothing reaches the database until the user confirms, so a wrong guess costs
  // a keystroke rather than a wrong ledger. The one field that cannot be guessed
  // from a card export — its opening balance — says so instead of guessing zero.

  const MONTHS = /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i;

  // `Chase0000_Activity_20260920` → Chase / 0000.  `August2026_0000` → _ / 0000.
  function fromFilename(filename) {
    const base = String(filename || '').replace(/\.[^.]*$/, '');
    const lead = /^([A-Za-z][A-Za-z&' -]{1,24}?)[ _-]?(\d{4})(?![\d])/.exec(base);
    let bank = null, last4 = null;
    if (lead && !MONTHS.test(lead[1].trim())) { bank = lead[1].trim(); last4 = lead[2]; }
    if (!last4) {
      // A four-digit group standing on its own, ignoring anything that reads as
      // a year — exports are routinely stamped with one.
      const groups = [...base.matchAll(/(?:^|[_\-. ])(\d{4})(?=[_\-. ]|$)/g)].map((m) => m[1]);
      last4 = groups.reverse().find((g) => !/^(19|20)\d\d$/.test(g)) || null;
    }
    return { bank, last4 };
  }

  const dayBefore = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };

  function suggestAccount({ filename = '', headers = [], rows = [], mapping = {} } = {}) {
    const { bank, last4 } = fromFilename(filename);
    const has = (k) => mapping[k] !== null && mapping[k] !== undefined;

    // A card export names what a charge was spent on and carries no running
    // balance; a deposit account is the other way round. Failing both, a file
    // that is almost entirely outflows is a card statement.
    const amounts = rows.map((r) => r.amount).filter((a) => a !== null && a !== undefined);
    const mostlyOut = amounts.length > 0 && amounts.filter((a) => a < 0).length > amounts.length * 0.8;
    const kind = has('categoryCol') || (!has('balanceCol') && mostlyOut) ? 'card' : 'cash';

    // A category column means a card and a balance column means a deposit
    // account; either way the file said so. Without one, the guess rests on the
    // amounts leaning one way, which a short statement barely supports — a
    // two-row card export looks exactly like a quiet month of checking. Say when
    // it is a guess rather than presenting it as read from the file.
    const kindConfident = has('categoryCol') || has('balanceCol');

    // Nothing in these files states a currency. The one thing that does travel
    // with it is the locale of the statement itself.
    const cjk = /[一-鿿]/.test(headers.join(' '));
    const currency = cjk || mapping.dateFormat === 'roc' ? 'TWD' : 'USD';

    const notes = [];
    let openingBalance = 0;
    let openingDate = null;
    let openingSource = null;

    // The earliest row that carries a balance fixes the opening figure exactly:
    // either it is a balance-only anchor line, or the balance after it minus the
    // amount that produced it. Walked in date order, because a statement listed
    // newest first would otherwise hand back its latest row.
    const chronological = inDateOrder(rows).filter((r) => r.date && r.balance !== null && r.balance !== undefined);
    const first = chronological[0];
    if (first && first.amount === null) {
      openingBalance = first.balance;
      openingDate = first.date;
      openingSource = 'anchor';
      notes.push(`期初餘額取自檔案裡的餘額列（${first.date}）。`);
    } else if (first) {
      openingBalance = round2(first.balance - first.amount);
      openingDate = dayBefore(first.date);
      openingSource = 'derived';
      notes.push(`期初餘額是從最早一筆（${first.date}）的餘額倒推的：${first.balance} − (${first.amount})。`);
    } else if (kind === 'card') {
      notes.push('信用卡對帳單沒有餘額欄，期初欠款推不出來——請自己填，**欠款是負數**。');
    } else {
      notes.push('這個檔案沒有餘額欄，期初餘額推不出來，請自己填。');
    }

    const dates = rows.map((r) => r.date).filter(Boolean).sort();
    if (!openingDate && dates.length) openingDate = dayBefore(dates[0]);

    if (!kindConfident) {
      notes.push(`這個檔案沒有分類欄也沒有餘額欄，「${kind === 'card' ? '信用卡' : '現金／存款'}」是從金額正負推的，請確認一下。`);
    }

    const label = bank && last4 ? `${bank} ...${last4}` : bank || (last4 ? `...${last4}` : '');
    return {
      institution: bank ? { name: bank, kind: kind === 'card' ? 'card' : 'bank', country: currency === 'TWD' ? 'TW' : 'US' } : null,
      name: label,
      kind,
      kind_confident: kindConfident,
      currency,
      opening_balance: openingBalance,
      opening_date: openingDate || dates[0] || null,
      opening_source: openingSource,
      covers: dates.length ? { from: dates[0], to: dates[dates.length - 1], rows: dates.length } : null,
      notes,
    };
  }

  // Dual-environment, the same three lines `web/html.js` ends with: onto
  // the global for the browser's classic scripts, onto module.exports for
  // Node. Everything above stays inside the closure.
  const api = {
    decode, sniffEncoding, parseCsv, sniffDelimiter, parseDate, parseAmount,
    round2, detectHeaderRow, guessMapping, repairRagged, extractRows,
    fingerprint, markDuplicates, checkBalanceChain, inDateOrder,
    suggestAccount,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
