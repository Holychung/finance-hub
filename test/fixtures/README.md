# Statement fixtures

One file per real statement shape, so `test/api.test.js` can read the same
bytes a bank actually writes, and so there is something to drag into the
import page when you want to see a path work.

## The rule: the shape is copied, the content is invented

**Every value in these files is made up.** Merchants, amounts, account
numbers, reference numbers, dates — invented. Phone numbers use the reserved
`555-01xx` range and masked card digits are `0000`. Nothing here came out of
anybody's account.

**Every byte of the shape is real.** Header wording, column order, date
format, quoting, padding, line endings, row order, and which column carries
which sign are all copied from a real export, because that is the only part
these files exist to document. A fixture that parses cleanly because it was
tidied up proves nothing.

Those two rules pull in opposite directions exactly once, and the shape wins:
where a bank writes something ugly — a trailing space inside a description, a
`null` in the middle of a merchant string, a trailing delimiter on every row —
the fixture writes it too.

**Never put a downloaded statement in here.** `.gitignore` ignores `*.csv`
and `*.pdf` everywhere except this directory and `githooks/pre-commit` refuses
them anywhere else, so this is the one path where the guard is off. It is off
by path, not by content: nothing checks whether what you added is real. The
backstop is `樣本目錄裡不准有沒讀到的檔案` in `api.test.js` — every file in
here but this README must actually be loaded by a test, so a file dropped in
and forgotten does not sit here quietly.

## Loading one

```js
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const CITI_CSV = fixture('citi-checking.csv');
```

Read as bytes, not rebuilt from an array of lines: the line endings and the
trailing delimiters are part of what is being tested. `fixture()` records
every name it loads, which is what the registry test compares against the
directory — so there is no separate list to keep in step. A PDF goes through
`fixtureBytes()`, which records the same way and hands back a Buffer.

## What is here

| file | shape it documents | 換行 |
|---|---|---|
| `esun-savings.csv` | 玉山 deposit export: ROC dates, `支出金額`/`存入金額` in two columns, thousands separators inside quotes, a `合計` footer row that must be refused, and two same-day same-amount rows differing only by note | CRLF |
| `firstrade-brokerage.csv` | The plainest US shape: `MM/DD/YYYY`, one signed Amount column. Its ACH row is the other leg of 玉山's 轉出至證券戶, exact at the 2026-07-05 rate | CRLF |
| `boa-checking.csv` | BoA deposit export: a five-line summary block before the header, a balance-only opening row, a running balance, and the raw `"` BoA writes inside an already-quoted description — two rows of which shift | CRLF |
| `boa-card.csv` | BoA card export: no balance column, and a `Reference Number` that is a run of spaces on bank-generated rows such as interest | CRLF |
| `chase-checking.csv` | Chase deposit export: a 7-column header over a uniformly 8-field body (trailing delimiter on every row), newest first | CRLF |
| `chase-card.csv` | Chase card export: two date columns (`Post Date` is the posting one), a `Category` column, no balance column | CRLF |
| `citi-checking.csv` | Citi deposit export: 5-column header over a 6-field body, `MM-DD-YYYY` with dashes, `Debit`/`Credit` in two columns with credits **positive**, newest first, no balance column, and a `Status` column that says `Pending` on the row that has not posted | LF |
| `citi-savings.csv` | The same shape again with different content, because the two Citi deposit products download identically | LF |
| `citi-card-2025.csv` | Citi card export: the same header, and nothing else the same — no trailing delimiter, `MM/DD/YYYY` with slashes, and credits written **negative** | LF |
| `citi-card-2026.csv` | The year after, so the pair can be imported into one account | LF |
| `capitalone-360-checking.csv` | Capital One deposit export: an **unsigned** `Transaction Amount` with the direction in `Transaction Type`, `MM/DD/YY` two-digit years, a running balance, newest first | LF |
| `capitalone-venture-card.csv` | Capital One card export: two date columns (`Posted Date`, spelled unlike Chase's), `Debit`/`Credit` in two columns, a `Category` column, no balance column | LF |
| `capitalone-venture-card-empty.csv` | What Capital One hands back for a year with no activity: the header row and nothing else | LF |
| `fidelity-401k.csv` | Fidelity retirement plan history: a blank line, a `Plan name:` line and a `Date Range` line above the header, one signed `Amount`, a `Transaction Type` saying what each row is, a `Shares/Unit` column, newest first, no balance column | LF |
| `fidelity-401k-2024.csv` | The same history shape over a different account: a day on which two funds are sold out and two bought, a money market at $1.00 whose interest is a `Dividend` row, unit counts above a thousand grouped inside the quotes | LF |
| `fidelity-401k-2024.pdf` | That account's NetBenefits *Statement Details* page, saved from Chrome as a PDF: Chrome's own header and footer on every page, and a table header printed again where the table breaks across a page | — |
| `fidelity-401k-2024.json` | Every figure the PDF prints, as numbers, and the PDF's SHA-256 | LF |

The 換行 column is not a typo. Citi and Capital One ship LF, the others ship
CRLF, and both have to parse — `.gitattributes` marks the directory `-text` so
git never normalises the difference away.

### What each one is built to exercise

`citi-checking.csv`

- the padded body (a 5-column header must not make all 8 rows look shifted)
- `MM-DD-YYYY`, which no other fixture here uses
- `Debit` → outflow, `Credit` → inflow, from the column rather than the sign
- a `Pending` row, which must not import
- **two byte-identical rows** (08-28, 250.00, same description): both must
  survive, because two grocery runs of the same amount on one day are two
  transactions
- a comma inside a quoted description (`Transfer to Savings, monthly`)
- a `Payment to Citi Card` leg that pairs with the card file's payment

Cleared rows sum to **6,100.00**; with the pending row wrongly included it
would be 5,935.00, which is the number that says the pending rule broke.

`citi-savings.csv`

- the same deposit shape, to prove the mapping is not tuned to one file
- a description with a trailing space, which Citi really does write
- the other leg of the `Transfer to Savings` pair, same date and amount

Sums to **58,000.00**.

`citi-card-2025.csv` and `citi-card-2026.csv`

- credits written negative, so a payment still has to come out positive
- a charge, a refund of a specific charge, an annual fee, a long airline
  description, a merchant name containing a comma
- `CREDIT REFUND AS REQUESTED` as a **debit**: the description says credit and
  the column says otherwise, and the column is right — Citi is handing back an
  overpayment, which is money owed again
- a running story that stays coherent: 2025 ends owing **2,160.00**, 2026 pays
  it down to **0.00**, so the two files imported into one account leave the
  card at zero. That total is the end-to-end check on the sign handling — the
  five payments and refunds come to 9,975.00, so honouring the sign in the
  cell instead of taking the direction from the column turns all five around
  and the card lands at -19,950.00 rather than zero.

`capitalone-360-checking.csv`

- an amount column with **no sign at all**: the direction is `Credit` /
  `Debit` in `Transaction Type`, and ignoring it imports every withdrawal as
  income with nothing on screen to say so
- `MM/DD/YY`, which collides exactly with the 民國 shape — `09/13/26` is
  refused as 民國 9 年 13 月, and `09/08/26` and `07/01/26` silently become
  1920-08-26 and 1918-01-26, both valid, both in the dedup fingerprint
- a payroll, rent, interest, an ATM withdrawal and a card payment, so the
  typed path is exercised rather than merely reached
- a `CAPITAL ONE CRCARDPMT` leg that pairs with the Venture file's payment

The running balance chains across all eight rows, 54,000.00 → **72,819.82**.
That chain is the proof the signs are right: read the type column wrongly and
it breaks on every Debit row.

`capitalone-venture-card.csv`

- `Posted Date` rather than `Post Date`, which matches none of the posting-date
  hints unless that exact spelling is listed — and then `Transaction Date`
  wins instead. Seven of the eight rows post on a different day
- `Debit`/`Credit` in two columns on a US card, so a purchase is already
  negative and a payment already positive
- a refund that is not a payment, a finance charge, and seven distinct
  categories
- the `CAPITAL ONE AUTOPAY PYMT` leg of the checking file's card payment

Sums to **-722.93**.

`capitalone-venture-card-empty.csv`

- a real download that contains no rows, which must preview as an empty file
  rather than as an error

`fidelity-401k.csv`

- a preamble above the header: a blank first line, a plan-name line whose
  name carries an **unquoted comma** (so that line splits into one cell more
  than it means) and trailing spaces, a `Date Range` line padded with empty
  cells, and two blank lines. The header has to be found under all of it
- `Investment` as the description: it names the fund, and nothing else in the
  file says which row is which
- `Transaction Type` saying what each row is, in four words. `Contributions`
  and `Dividend` import, as income and as a dividend. `Exchanges` and
  `Realized Gain/Loss` move no money in or out of the plan and must not
  import at all
- five years of a plan, 160 rows: a monthly contribution split 80/20 between
  an S&P 500 index fund and a growth tech fund, stepping up once a year;
  quarterly dividends on the index fund and a yearly one on the tech fund;
  and a rebalance back to 80/20 every April — one fund sold, the other
  bought, the same day, with a realized gain/loss line for the fund sold. Four
  of those sell tech and one, in the first year's fall, sells the index fund
- amounts and units quoted with thousands separators, negative on the leg
  that leaves a fund; units to three places
- no balance column, so nothing to chain and no opening balance to derive

Everything that imports sums to **200,000.00**: 195,000.00 of contributions,
156,000.00 into the index fund and 39,000.00 into tech, and 5,000.00 of
dividends. The five gain/loss lines would add 972.77 that nobody put in, and
every rebalance day nets to zero, so an exchange imported as a flow shows up as
an expense and an income of the same amount rather than in the total. Unit
prices follow an invented path, so the file's units carry a market value the
ledger does not read.

`fidelity-401k-2024.csv`, `fidelity-401k-2024.pdf`, `fidelity-401k-2024.json`

One invented account, 01/01/2024 to 09/18/2026, three ways. All three come out
of one run of `scripts/fixtures/fidelity-401k-2024.js`, which needs Google
Chrome. Change the account there and run it again; never edit these files by
hand. The JSON carries the PDF's SHA-256, so a PDF from any other run fails the
suite.

- the history is `fidelity-401k.csv`'s shape exactly — the preamble, the
  quoting, newest first, LF — over a different account. Contributions split
  80/20 between an S&P 500 index fund and a growth tech fund, matched at 50%,
  stepping up each January; quarterly dividends on the index fund and a yearly
  one on tech
- one day, 02/09/2024, on which a target-date fund and a money market are sold
  out entirely and the proceeds bought into the two funds: four `Exchanges`
  legs and one `Realized Gain/Loss` line, the first file where more than one
  fund leaves on the same day. All five must be held back
- a money market at $1.00 whose interest is a `Dividend` row, and unit counts
  above a thousand, grouped with a comma inside the quotes
- the statement is NetBenefits' Statement Details page as Chrome saves it:
  Chrome's header (the time it was printed, the page title) and footer (the
  page's address, `1/3`) on every page, and the Market Value table's column
  header printed again where the table breaks across a page. A PDF saved from
  the browser comes out of Skia's writer, and so does this one. The logo, the
  phone glyph and the allocation chart are pictures, so they add nothing to the
  text layer
- nothing reads the PDF yet. It is here so that whatever reads it is written
  against the real kind of file. Extractors merge text that shares a baseline
  (PDFKit puts the repeated table header on the same line as the page header's
  date), so a reader has to work from glyph positions, not from extracted lines
- the JSON is every figure the PDF prints, as numbers, for a reader's output to
  be compared against

The history's units, added to the shares the statement opens with, are the
shares it closes with, exactly. At the statement's closing prices they come to
its ending balance, **198,807.71**. Imported into an account opened at the
statement's beginning balance, the ledger holds **140,328.58**: the money put in
plus the dividends. The difference, **58,479.13**, is the change in market value
the history does not carry.

## Adding a bank

Add the file here, load it in `test/api.test.js` (via `fixture()`, and put it
in `BANK_FIXTURES` so the pipeline guard sweeps it), and give its own quirk a
named test. See "Adding a bank" in `CLAUDE.md`.
