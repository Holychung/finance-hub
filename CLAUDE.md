# Finance Hub

A local-only personal asset ledger: bank accounts, brokerages, cards, loans, TW/US
holdings, and every transaction, in one place. Data lives in
`~/.finance-hub/finance.db` — outside any checkout — and never leaves the machine.

## Hard rules

- **Zero dependencies.** No `package.json`, no `npm install`, no bundler, no CDN.
  Node 22+ built-ins only (`node:sqlite`, `node:http`, `node:crypto`). If a task
  seems to need a library, write the 40 lines instead or say it cannot be done —
  do not add a dependency. This is a finance app: it must run offline and carry
  no supply chain. `test/deps.test.js` and `githooks/pre-commit` both refuse a
  `package.json` or a lockfile, because this is the rule most easily broken by
  one commit that otherwise works perfectly.
- **Local only.** The server binds `127.0.0.1`. Never `0.0.0.0`, never a public
  interface, no auth layer, no telemetry.
- **Do not weaken the three request guards in `index.js`.** Binding to loopback
  does nothing about the browser on the same machine. `hostAllowed` stops DNS
  rebinding, the `Origin` check on non-GET stops cross-site writes, and the
  `application/json` requirement stops the preflight-free content types. Never
  add an `Access-Control-Allow-Origin` header; reads are currently protected
  precisely because there isn't one. Widening access to the LAN goes through
  the `HOST` / `ALLOWED_HOSTS` env vars, not by deleting a check.
- **The CSP is the fourth guard, and the only one the browser enforces for
  us.** Those three decide who may reach the server; `default-src 'none'`
  decides where the page may reach, which is what makes "no outbound calls" a
  mechanism instead of a habit. It is set once at the top of the request
  handler so every response carries it, 403s included. **There are two of
  them and one list**, in `server/csp.js`: the local server needs
  `connect-src 'self'` to reach its own `/api`; the hosted demo has nothing
  to reach and ships `'none'`, so that page is *incapable* of sending
  anything anywhere. Keep the gap exactly one directive wide — a second copy
  of the list drifts on the first change here, and the only thing that
  notices a weakened CSP is somebody reading it. `style-src` admits
  `'unsafe-inline'` only because the views still write inline `style=`
  attributes; that is a reason to finish moving them into the stylesheet, not
  a licence to add a host to any other directive. Adding one — or a `*` — to
  `script-src`, `connect-src` or `img-src` is how the ledger starts talking to
  somebody, so `test/api.test.js` fails on it.
- **Static paths stay contained.** `path.resolve()` then compare against the
  root *plus a separator*. A bare `startsWith(WEB_DIR)` also accepts a sibling
  directory whose name merely starts with `web`. There are two roots now —
  `web/` and, under `/shared/`, `shared/` — and the rule is per root, not a
  single check widened to cover both.
- **No outbound network calls, with exactly one opt-in exception.** The default
  is still offline: `test/deps.test.js` scans `web/`, `shared/`, `server/` and
  `scripts/` for external URLs and `style.css` for external `url()` / `@import` —
  a font import is the quiet version of this, and it tells a stranger's server,
  on every page load, that this machine just opened its ledger. The one
  exception is the daily close fetch in `server/prices.js` (Yahoo), **off by
  default**, run **server-side** so the browser page still never connects out
  (its CSP is unchanged), and allowed by the deps scan **only in that one file**
  — the exception is pinned to a file, not loosened everywhere. Broker APIs are
  still to come and hold to the same shape: opt-in, off switch, server-side.
  Anything new that reaches the network is one of these or it is a bug.
- **No AI features.** Deliberate product decision, not an oversight.

## Layout

```
server/paths.js   where the ledger lives      (pure — no mkdir, no open)
server/csp.js     the CSP, both of them — local 'self', hosted 'none'
server/migrations.js  every schema version, in order — the only schema there is
server/migrate.js     applies them; takes a handle, opens nothing, knows no paths
server/db.js      connection, migrate-on-open, snapshot/backup helpers
shared/currency.js  symbol and decimal places per currency, roundTo, round2,
                  and how a quantity and a unit price are written
shared/kinds.js   what kinds of account, transaction and market exist — the
                  only list
shared/sha1.js    synchronous SHA-1, because the browser's is async
shared/csv.js     decode, parse, map, dedup    (no DB access — pure functions)
shared/money.js   the pure half: every `compute*`, plus round2 and the dates
shared/rules.js   category rules: normalise, match, plan
shared/spending.js  monthly in/out, category breakdown, recurring charges,
                  and how much of each budget a month has used
shared/export.js  rows -> a CSV file, BOM and CRLF for Excel
shared/demo-seed.js  the demo book, and the sample statement — invented, built
                  fresh from a date, opened by both the seeder and the browser
server/money.js   the loaders — one query-runner per `compute*` in shared/
server/prices.js  the app's one outbound call — opt-in daily close fetch, off
                  by default, server-side; deps-test allows Yahoo only here
server/api.js     JSON handlers, registered via on(method, pattern, fn)
server/index.js   HTTP server, request guards, routing, static files; loads the
                  rows the CSV export formats and names the download
web/index.html    the shell, and the <script> list that *is* the dependency graph
web/html.js       the escaping html`` tag and mount() — the only way to the DOM
web/storage-http.js  the only fetch() in the frontend, and the export URLs
web/storage-demo.js  the same routes answered from a Map, for the hosted demo
web/storage.js    picks one at load, by origin, and never falls back
web/core.js       DOM/money helpers, toast, modal, captureUi, `views = {}`
web/charts.js     lineChart + barBreakdown, hand-built SVG, no colour of its own
web/tables.js     tables more than one view renders
web/forms.js      modal editors more than one view opens
web/view-*.js     one file per route, each registering its own views.<name>
web/app.js        router, link interception, sidebar — loaded last, boots render()
test/api.test.js  node:test suite, starts and stops its own server
test/fixtures/    one file per statement shape — invented rows, real shape
test/paths.test.js   ledger location, profiles, the data-dir migration script
test/migrate.test.js the schema migration runner
test/seed.test.js    what the demo seeder must produce to be worth running
test/money.test.js   the pure half of money.js, over plain arrays
test/budgets.test.js a budget's spent figure is the breakdown's, for its month
test/prices.test.js  the close fetch, offline — injected getter, throwaway db
test/currency.test.js  the scale follows the currency, and round2 is unchanged
test/kinds.test.js   the kind list is complete, and the rules encoded in it
test/sha1.test.js    SHA-1 against node:crypto, and shared/ loaded both ways
test/storage.test.js the storage seam, and which adapter each origin gets
test/demo-store.test.js  the demo adapter against a real server, route by route
test/export.test.js  the CSV bytes: BOM, CRLF, escaping, each sheet's columns
test/html.test.js    the frontend escaping rules below
test/pack.test.js    what the hosted copy contains, and what it must not
test/deps.test.js    zero dependencies and no external URLs, as mechanisms
scripts/seed-demo.js          invented data for a demo profile; refuses the
                              personal ledger outright
scripts/pack-demo.js          copies web/ + shared/ into dist/ for a static
                              host; adds a CSP and a commit stamp, nothing else
scripts/fixtures/             builds the invented Fidelity statement PDF, its
                              history and its figures; needs Chrome, run by
                              hand, never by the suite
githooks/pre-commit           refuses staged .db / .csv / .pdf / .env
docs/design/                  design comps, as a record — history, not spec
```

Handlers may be `async` — the router awaits them. Keep them sync unless the
work genuinely is not; **none of them is today**. The pre-import snapshot used
to be the one exception and stopped being one when `snapshot()` moved from the
async `backup()` to a synchronous `VACUUM INTO`, which it had to do so the
migration runner could take one at require time.

## Test before declaring done

```
node --test                      # from the repo root; nothing else to start
node --test --test-name-pattern="轉帳"
node --test --experimental-test-coverage test/api.test.js
```

`test/api.test.js` spawns its own server on a free port against a throwaway
database and tears both down afterwards, so there is nothing to set up and
nothing to clean. It never touches the real ledger.

**The throwaway database goes in its own `mkdtemp` directory, not just under a
unique filename.** `paths.js` derives `DATA_DIR` and `BACKUP_DIR` from the
database's directory, so a shared parent means a shared `backups/`: every
concurrent run counts against the same `KEEP_BACKUPS` limit and teardown
deletes the whole directory out from under the others. It also keeps teardown
honest — the directory it removes is one this process created. Anything else
that later derives a path from `DB_PATH` inherits the same requirement.

558 tests across 90 suites cover Big5 decoding, ROC dates, two-digit years,
two-column debit/credit, unsigned amounts with a direction column,
overlapping-range dedup, cross-currency transfer pairing, net worth, a coin's
eight places and its market's case surviving every endpoint, unvested coming
off net worth and never off a balance, a change in market value moving a
balance and no total, a budget's spent figure being the breakdown's for its
month, the
price-history lookup (latest at or before a date, and nothing dragged back
before the first observation) and the v6 backfill that seeds it,
pre-import backup, balance reconciliation, import revert, CSV BOM, the three
request guards and the CSP, the malformed-statement handling below, the
pipeline invariant over every bank fixture, pending rows and a retirement
plan's exchanges never importing, a plan's history and its statement agreeing
to the cent, the
zero-dependency and no-outbound rules (with the one opt-in close fetch tested
offline through an injected getter, and the deps scan pinning Yahoo to
`server/prices.js`), the ledger location rules, the
schema migration runner, the pure half of `money.js`, the demo adapter
answering the same as a real server, the demo book being one definition the
seeder and the browser both open, `shared/` loading
identically under `require` and as a plain `<script>`, the storage seam, the
hosted copy containing every file `index.html` asks for and nothing else, and
the whole frontend loading in `index.html`'s order with every view
registered. All must pass. Add cases for anything new.

Statement fixtures are files, not strings: `test/fixtures/*.csv`, one per
shape, invented content in a real bank's shape. See "Adding a bank".

`test/paths.test.js` evaluates `server/paths.js` in a child process under a
throwaway `HOME`, so it can assert where the real ledger would go without ever
creating it.

Note: `node --test test/` does not work on Node 22 — pass the file or no
argument at all.

**There is no CI, so run the suite on the merge *result*, not on the branch.**
GitHub calling a PR `MERGEABLE` / `CLEAN` means the text does not conflict and
nothing more; nothing anywhere runs the merged tree before it lands. Two
branches that are each green go red together the moment one of them moves a
file the other requires — which is exactly how `main` broke on 2026-09-21:
`test/seed.test.js` required `../server/spending` while, in a different PR,
`spending.js` moved to `shared/`. Both PRs were green, both merged cleanly,
and the merge was broken. Before merging anything that has been open while
`main` moved:

```
git -C <worktree> merge origin/main && node --test
```

## Dev loop

`node --watch server/index.js` restarts on save. There is no frontend build
step, so a browser refresh is enough for anything under `web/` or `shared/`.

## `shared/` — one copy, two environments

`shared/` holds the domain logic that Node and the browser load **from the
same files**: statement parsing, the fingerprint hash, the arithmetic half of
`money.js`, the categorisation rules, the spending breakdown, and turning rows
into a CSV file. Node `require`s them; the browser loads them as classic
`<script>`s, served from `/shared/`. There is no bundler and no build step —
each file ends with the three lines `web/html.js` ends with, putting its
exports onto the global when there is no `module` and onto `module.exports`
when there is.

Four rules, and the first is the only one that is a judgement call:

- **Nothing in `shared/` may require `db`, `fs`, `paths`, or anything under
  `node:` that a browser lacks.** The moment one does, the file is not shared,
  it is a server file in the wrong directory — and the failure is silent until
  someone opens the page. `test/money.test.js` fails if a `compute*` reaches
  for `db`; `test/sha1.test.js` runs the whole of `shared/` in a bare `vm`
  context with no `require` and no `module` and compares its answers against
  the required copy's, which is the check that actually catches a stray
  `node:` import.
- **Each file is wrapped in the IIFE**, not left at top level like `web/*.js`.
  Those share one script scope, and `csv.js` alone declares 36 names including
  `decode`, `round2` and `fingerprint` — `round2` already existed in
  `web/core.js`, and two `const`s of one name in that scope is a SyntaxError
  and a blank page. The closure makes the clash impossible rather than
  detectable.
- **A `shared/` file reaches its dependencies the same way round**:
  `require('./x')` in Node, off the global in the browser. Which means
  **`web/index.html`'s order matters** — `sha1.js` before `csv.js`, and both
  before anything in `web/` — and `test/html.test.js` pins it.
- **Every guard that covers `web/` covers `shared/` too.** `SOURCE_DIRS` in
  `test/deps.test.js` and the file list in `test/html.test.js` both name it.
  Leaving it out does not fail anything; it just quietly stops checking the
  code that moved.

The hash is why `shared/` needed inventing at all. `crypto.createHash('sha1')`
is Node-only and the browser's `crypto.subtle.digest` is **async**, while the
fingerprint is computed inside a synchronous row-mapping loop that reaches all
the way up through `markDuplicates`. `shared/sha1.js` is sixty lines of SHA-1
so neither has to change — and because the dedup contract forbids the
definition moving, `test/sha1.test.js` holds it against `node:crypto` over the
standard vectors, every length from 0 to 200, non-ASCII descriptions and three
thousand random Unicode strings.

## Money conventions

- Transactions store the **native currency** amount: positive in, negative out.
- **Nothing is converted.** A statement says 58,420.15 USD and the ledger says
  it back. Balances, net worth, series and holdings are all reported in the
  account's own currency, so `netWorth` returns one block per currency and
  **there is no single total** once more than one is held — because there
  isn't one. USD and TWD do not add without a rate, and inventing one to make
  a headline number look tidy turns a fact into an estimate that silently
  moves whenever a rate is edited.
- **FX rates survive for exactly one job:** deciding whether a TWD outflow and
  a USD inflow are the same transfer (`findTransferCandidates`). Nothing
  converted there reaches a balance or a total. Without rates, cross-currency
  transfers simply go unrecognised and both legs keep counting as income and
  expense. Rates remain bound to their own date: `fx.on(d)` returns the most
  recent at or before `d`.
- Round through `round2()` at every write. Fingerprints use `.toFixed(2)` so
  float noise cannot change a hash — and that `.toFixed(2)` is frozen by the
  dedup contract, so it never becomes `roundTo`.
- **Two decimal places is a property of a currency, not of money.**
  `shared/currency.js` holds the symbol and the scale for each one, and
  `roundTo(n, dp)` takes the scale as an argument; `round2` is the two-place
  case and still the right answer for anything that came off a statement.
  Never write `Math.round(n * 100) / 100` — a guard in `test/html.test.js`
  fails on it, because that is the decision buried where nobody finds it
  again. A currency with no entry falls back to two places and its own code as
  the symbol: `JPY 1,234` reads as unfinished, which it is, where `NT$1,234`
  reads as a fact and is wrong.
- **A balance is what the account is worth to you, so liabilities are
  negative.** A card you owe 1,234 on has a balance of -1,234, which is why
  `netWorth` can be a plain sum that never asks what kind of account it is
  adding. Two consequences, both of which bite silently:
  - `opening_balance` for a `card` or `loan` has to be entered negative, which
    is not what the statement shows. Enter the statement figure and net worth
    is out by twice the balance with every total still looking plausible. The
    account form warns while the number is being typed, and
    `liabilitiesInCredit()` keeps flagging it on the overview afterwards. It
    is never refused: an overpaid card really is in credit.
  - **A card's web view and its CSV export disagree about signs, and the file
    is the one that is already right.** The screen states what you owe, so a
    purchase shows positive; the export states what the account is worth, so
    the same purchase is negative and needs no inverting. Bank of America's
    export does exactly this: the charge its Activity page shows as positive
    is negative in the file. Believe the file, not the screen.
    Other issuers do export the screen's convention, and a card export has no
    running-balance column to chain against, so the preview flags a liability
    account receiving a file that is mostly inflows
    (`summary.sign_suspect`). That count is the only net there is: every row
    of an inverted file parses perfectly.
  - **In a two-column Debit/Credit file the column is the direction, and the
    sign inside the cell is ignored.** Citi is why that has to be said out
    loud: under one identical `Status,Date,Description,Debit,Credit` header,
    its deposit export writes a credit positive (`,,900.00,`) and its card
    export writes one negative (`,,-3200.00`), without exception in either.
    `extractRows` takes `-abs(debit)` / `+abs(credit)`, so one mapping reads
    both correctly. Honour the sign instead and every card payment becomes
    another charge — on the one export with no balance column to catch it.
    The two `citi-card-*` fixtures are a card's whole life and sum to zero
    only this way round.
- **Holdings and brokerage cash are separate.** Buying a stock is cash out of the
  brokerage account (a txn) plus shares into `holdings`. A currency's net worth
  is `sum(its account balances) + sum(its holding market values)`. Never fold
  market value into an account balance — that double counts.
- **A coin is a holding, and a wallet is an account that holds it.** The
  market is `TW` | `US` | `CRYPTO`, from `MARKETS` in `shared/kinds.js`, and
  that entry is also where a holding's default currency and quantity places
  come from — never a ternary on the market, which is how a third market was
  once priced in TWD (`test/html.test.js` fails on `market === '…'`). Markets
  are upper case and refused outside the list at every endpoint, holdings and
  prices alike: `/api/prices` upper-cases, so a holding stored in any other
  case never finds its series and says nothing. `holdings.decimals` is the
  scale a quantity is *shown* at, not a precision stored values are rounded
  to; a unit price shows at least two places and every place it carries.
- **`accounts.access` says whether there is a rule between you and the
  money** — `liquid` or `restricted`, from `ACCESS` in `shared/kinds.js`. It
  is a property, never inferred from the kind: a self-custody wallet and a
  locked stake can be the same kind and opposite answers. `computeNetWorth`
  reports each currency whole **and** in two halves, `liquid` and
  `restricted`, each the same shape as the whole; a holding goes with its
  account and unvested with its plan, so the halves add up to the total by
  construction, and `test/money.test.js` fails if a rate appears anywhere in
  that arithmetic. Face value, never discounted, projected or annualised —
  the same reason there is no cross-currency total. The overview opens on
  可動用 with a 可動用／受限制／全部 switch, and always names the half not on
  screen. The API refuses an access outside the list rather than defaulting
  it, because a typo that became `liquid` is a retirement balance back in the
  spendable figure with nothing on screen to say so. A kind's `access` in
  `shared/kinds.js` is only where a new account starts (`defaultAccessFor`):
  retirement starts restricted.
- **A retirement balance is the statement's figure, and `unvested` comes off
  net worth, never off the balance.** The statement counts the unvested share
  in its total and every balance check is compared against that total, so
  taking it off the balance would put each check out by exactly that amount.
  `computeNetWorth` subtracts it per currency as its own negative
  `by_kind.unvested` row — not off the account's kind, because a plan held
  entirely in funds has a cash balance of zero — and the series, being
  ledger only, leaves it out. `tax_status` is a label and never arithmetic;
  `test/money.test.js` fails if `shared/money.js` reads it. The API refuses a
  negative or unreadable `unvested` rather than letting `N()` make it 0.
- **A change in market value is a row, and it moves no money.** The balance
  gets to the statement's figure through `kind: 'valuation'` rows — the
  difference a balance check shows, or a balance-only plan's reported gain —
  so the ledger stays a sum of rows and the series stays ledger only. `flow:
  false` on the kind in `shared/kinds.js` is what keeps it out of spending,
  the recurring detector and transfer pairing; `NON_FLOW_KINDS` is derived
  from the flag and `test/kinds.test.js` pins that. Nothing computes a
  valuation: the statement states it, the way it states the balance.
- **A budget is the user's number, and "spent" is the breakdown's.**
  `computeBudgets` calls `computeSpending` over the month's window rather than
  filtering rows itself, so transfers, valuations and refunds are treated
  exactly as the category breakdown treats them — one set of filters, not two
  that agree today. One standing amount per (category, currency), no history,
  nothing converted; `''` / 未分類 is refused, because it is the ledger not
  knowing yet. Nothing forecasts: the running month reports the days that have
  passed beside the share used, and a past month reports neither.
- Net worth series is **ledger only**. Holdings have no price history in phase 1,
  so folding today's market value into past points draws a line that never
  existed. Keep it that way until broker sync supplies real history.
- **An account enters the series on its `opening_date`, not before.**
  `opening_balance` is what the account held *on* that date, so carrying it
  back to the start of the chart invents months of a balance nobody had. It
  was doing exactly that until 2026-09-21 — `opening_date` was selected from
  the database and never consulted — and the symptom is the one that makes it
  hard to spot: with every account doing it at once the line comes out **flat
  at today's total** and only starts moving at the first imported
  transaction, which reads as a complete ledger rather than as a chart of the
  months actually imported. The series and `accountsWithBalances` are the same
  arithmetic over the same rows, so the last point equals the current balance;
  `test/money.test.js` asserts that, and it is the cheapest way to notice the
  two drifting apart again.
- **In `money.js` the name says whether it touches the database.**
  `compute*(…)` is pure — rows in, answer out, no `db`, no clock beyond a date
  you passed it. The bare name (`netWorth`, `reconcile`, `coverage`, …) runs
  the queries and calls the matching `compute*`. Exported names and signatures
  are the loaders', so `api.js` never has to know which is which.

  Write the new logic in the `compute*` and keep the loader thin. Net worth,
  cross-currency transfer pairing and reconciliation are the three things here
  most worth testing, and the split is what makes them ordinary function calls
  over arrays in `test/money.test.js` instead of an HTTP round trip against a
  spawned server. `test/money.test.js` pins the rule two ways: it scans each
  `compute*` body for `db` and fails on a hit, and it fails if a `compute*`
  has no loader of its own. Both were written after a first version of the
  scan turned out to be reading the parameter list instead of the body and
  passing with a `db.prepare` planted inside.

  Two functions are deliberately not split: `applyTransferPairs` and
  `unlinkTransfer` are writes, and nothing needs them pure yet.

## Creating an account from a statement

`/api/import/preview` takes **no account on purpose**. Requiring one made the
first import circular: the page sent you off to another view to type in an
opening balance the file already knew. Without an account it still parses,
skips the dedup it has nothing to compare against, and returns
`suggested_account`.

`suggestAccount()` is pure and advisory. Every field lands in an editable form
and nothing is written until the user confirms, so the rule is **say what the
file says, and say when it is a guess**:

- A `category` column means a card, a `balance` column means a deposit
  account; either way the file stated it and `kind_confident` is true. Failing
  both, the kind rests on the amounts leaning one way — a two-row card export
  looks exactly like a quiet month of checking — so it is flagged rather than
  presented as read.
- The opening balance is **exact** when a balance column exists: a
  balance-only anchor line (`anchor`) is the figure itself, otherwise it is
  the earliest row's balance minus the amount that produced it (`derived`),
  dated the day before. Walked through `inDateOrder`, or a newest-first file
  hands back its latest row.
- A card export has no balance column, so the opening debt **cannot** be
  derived. It says so and leaves zero rather than inventing one, and repeats
  the sign rule, because that is the field that silently doubles net worth.
- Nothing infers a currency it cannot see; it follows the statement's locale
  and is there to be changed.

## Dedup contract

```
fingerprint = sha1(account_id | date | amount.toFixed(2) | description
                   lowercased with whitespace and punctuation stripped)
```

Changing this definition invalidates every stored fingerprint and will make old
rows re-import as new. If it has to change, migrate the column in the same commit.

Rules: an `external_id` match wins outright. Otherwise, for the Nth row in a file
carrying fingerprint F, it is a duplicate only if the DB already holds more than N
rows with F — so two genuinely separate same-day same-amount entries both survive.

**The date is in the fingerprint, so which date column is chosen is a one-way
decision.** A Chase card export carries `Transaction Date` and `Post Date` and
they disagree on most rows; switching after an import
re-imports almost everything, and a card export has no `external_id` to catch
it. `HINTS.date` therefore ranks posting date above transaction date: it is
what the statement balance is computed on, what a deposit account exports, and
what puts a card payment in the same window as its counterpart in checking.

**Every spelling of it has to be listed, one per issuer.** Chase writes
`Post Date`, Capital One writes `Posted Date`, and neither reads as the other.
A spelling that is missing does not fail loudly — the column falls through to
the generic `date` hint, `Transaction Date` outscores it, and the file imports
against the wrong date with nothing on screen to say so. Capital One's two
columns disagree on most rows too.

**`MM/DD/YY` and a 民國 date are the same six digits, so `auto` reads only the
unambiguous ROC form** (a three-digit year — 民國 100 was 2011). Capital One
writes `09/13/26`: as ROC that is 民國 9 年 13 月 and is refused, but
`09/08/26` becomes a perfectly valid 1920-08-26 on a row reporting no error at
all, and it goes into the fingerprint. `looksRoc()` is the single predicate
for this, shared by `parseDate` and `guessMapping`'s sniff so the format the
mapping reports and the format applied cannot drift. A genuine two-digit ROC
year is still reachable by picking 民國 in the import form.

`category` is deliberately **not** in the fingerprint. Banks recategorise rows
between exports, and a row moving from Groceries to Shopping is the same
transaction.

**A row the bank has not finished writing must not be imported**, for the same
reason. Citi's `CURRENT_VIEW` download is what the screen shows, pending
authorisations included, and a `Status: Pending` row is provisional in all
three fields the fingerprint is made of: the amount settles, the date becomes
the posting date, the merchant string is rewritten. Import it and the posted
row arrives in the next download as a second transaction for the same
purchase, with no `external_id` to catch it. `markDuplicates` gives it its own
status, `pending`, **before** the dedup, so it neither imports nor consumes one
of the duplicate slots the posted row will need. Only a word that positively
means "not final yet" holds a row back (`PENDING_WORDS`): an unrecognised
status is a final status, so the check can only ever cost an import a row,
never let one through.

**A row that moves no money must not be imported either.** A retirement
plan's history (Fidelity's) says what each row is in `Transaction Type`. An
`Exchanges` row sells one fund to buy another inside the same plan, and the
day's legs net to zero; a `Realized Gain/Loss` row reports a gain already
inside the exchange beside it. Imported, the first is an expense and an
income of the same amount in the spending breakdown, and the second is money
nobody put in — and both parse perfectly. `markDuplicates` gives them status
`internal`, before the dedup like `pending`, and the rows that do import
carry the kind their word names (`Contributions` → income, `Dividend` →
dividend) instead of the import's single default. The column is recognised
by its cells (`activityColumn`), never its header: Chase's `Type` and Capital
One's `Transaction Type` would otherwise qualify. Only the plan's exact words
count, so the check only ever holds a row back. With no balance column, what
such a file imports is the money put in, not the market value, and the
account page says so.

## Where the ledger lives

**Never put the user's data inside the checkout.** It used to sit in
`<repo>/data/`, ignored by git, which protects against committing it and
nothing else. `git clean -xdf` — the ordinary way to tidy a working tree —
deletes an ignored directory without asking, and `data/backups/` went with it,
so the backup died alongside the thing it was backing up. Every worktree got
its own empty `data/`, which reads as total data loss. A repo is cloned,
cleaned, branched and deleted; a ledger is kept for years. Different lifetimes,
different directories.

```
~/.finance-hub/finance.db          personal, the default
~/.finance-hub/<profile>.db        FINANCE_PROFILE=<profile>
~/.finance-hub/backups/            pre-import snapshots, beside the book
<anything>                         FINANCE_DB=<path>, wins over both
```

- `server/paths.js` is **pure**: it resolves paths and reads nothing else. That
  is what lets `index.js` detect a stranded `data/finance.db` and exit *before*
  requiring `./api`, which pulls in `./db`, which creates the file it opens.
  Keep it free of side effects or that guard stops working.
- `DATA_DIR` derives from `DB_PATH`, never from `__dirname`. An explicit
  `FINANCE_DB` must not leave anything behind in the repo.
- `FINANCE_PROFILE` becomes a filename, so it is validated against
  `^[A-Za-z0-9_-]{1,32}$`. Empty means unset, not invalid.
- A non-personal profile is stated in the terminal banner and turns the sidebar
  badge amber. A demo book and the real one are the same app at the same
  address; without a visible label the only difference is what the numbers say.
- The migration copies with SQLite's `backup()`, **not** `fs.copyFile`. Under
  WAL the `.db` file alone is not the whole database, and a plain copy silently
  drops whatever is still in the `-wal`. It then compares row counts per table,
  and leaves the original untouched for the user to delete themselves.

Protection against committing data is layered, because any single layer fails:
`.gitignore` ignores `*.csv` and `*.pdf` wholesale (a statement arrives named
`stmt.csv` or `Statement.pdf` and matches nothing specific) but `git add -f`
walks past it and an
already-tracked file is never reconsulted; `githooks/pre-commit` reads what is
actually staged and refuses it. Enable it per clone with
`git config core.hooksPath githooks`.

## Adding a bank

`shared/csv.js` opens with the pipeline contract: the six stages, and what
each may assume of the one before it. Read it before changing any of them —
none can be understood on its own, because every bug found there so far has
been one stage concluding something about the whole file from a single
anomalous row.

**The invariant is that a bad row is local.** One row being wide, shifted or
refused may change how that row is reported and nothing else about any other
row. Both bugs broke exactly that, and both passed every test their own stage
had, because whether they bite depends on where the overflow lands and the
fixtures happened to push a blank into the slot that mattered.

So a new bank, card or account is always these four steps, in this order:

1. **Write `test/fixtures/<bank>-<product>.csv`** — a real file to work from,
   never a description of one. Copy the shape byte for byte: header wording,
   column order, date format, quoting, padding, line endings, row order, and
   which column carries which sign. **Invent every value.** Merchants,
   amounts, account and reference numbers, dates — all made up, `555-01xx`
   for phone numbers and `0000` for masked card digits. That directory is the
   one place `.gitignore` and `githooks/pre-commit` let a `.csv` or a `.pdf`
   through, and they let it through on its path alone: a statement you
   downloaded never goes in there. `test/fixtures/README.md` says what each file exercises;
   add your section to it.
2. **Load it with `fixture()` and put it in `BANK_FIXTURES`** in
   `test/api.test.js`. `fixture()` records every name it reads and the
   registry test compares that record against the directory, so a file
   nothing loads fails the suite with no second list to keep in step.
   `BANK_FIXTURES` is separate and is what buys the guard below.
3. **Give its own quirk a named test.** The combinations come from the list;
   the quirk does not.
4. **Make the file's arithmetic checkable end to end.** Build it so the rows
   add up to a number that is wrong in an obvious way if the parsing is
   wrong — the two `citi-card-*` files are a card's whole life and land on
   zero, which no sign mistake survives. A fixture that only proves it parses
   proves the least interesting half.

`BANK_FIXTURES` is what makes step 2 worth doing: the pipeline guard sweeps an
extra field through every position in a row of every file on that list, in
both the repairable and the unrepairable case, and fails if any other row
moves.

**Nothing in this repo may describe a real statement.** Not its row count, not
what fraction of its rows hit a bug, not a phrase from one of its
descriptions, not a balance. Those are facts about somebody's accounts wearing
the clothes of a technical note, and a comment is where they survive longest
because nobody re-reads one. State the behaviour and its magnitude — "the two
date columns disagree on most rows", "every row of a wide-bodied export is
refused" — which is what the rule needs anyway; the provenance was never part
of the argument.

**Every statement lives in `test/fixtures/` as a file**, so there is no second
pattern to copy from by mistake. The short CSVs written inline in
`test/api.test.js` are deliberately not statements: they are four-line
constructions isolating one pipeline rule (a header row with a trailing empty
cell, a shifted row inside a padded body), and they stay inline because
reading them next to the assertion is the point.

**Three ways a file can state a sign, and `amountMode` names which:**
`inout` (two columns, the Taiwanese default and what both Citi and the Venture
card use), `single` (one signed column, the US default), and `typed` — one
*unsigned* column plus a direction column, which is what Capital One's 360
Checking writes. The third is the dangerous one, because a file whose signs
are simply ignored parses perfectly: every withdrawal imports as income and
only the running balance disagrees.

The direction vocabulary is `HINTS.out` / `HINTS.in` themselves — a column
saying `Debit` in every cell is the same statement as a column headed `Debit`,
so there is no second list to keep in step. Two rules hold it together:

- **The header may not decide the mode; the cells do** (`directionColumn`).
  Chase heads its Sale/Payment/Return column `Type` too, and choosing `typed`
  on the header alone would refuse every row of a checking export. So
  `typed` needs the directions to actually read across ~90% of the file.
  Do not add "…and the amounts must be unsigned" on top: it reads like a free
  extra check and fails towards the silent answer, because one stray negative
  would drop the file back to `single` and import every withdrawal as income.
  A signed file is already safe — `extractRows` takes the magnitude
  absolutely, exactly as the two-column path does, so a row stating its
  direction twice is not negated twice.
- **A row whose direction will not read is refused, never guessed.** It is the
  one case where a number is present and there is still no amount, so it says
  which cell it choked on rather than reporting an unparseable amount.
  `Withdrawal from …` for 1,842.65 imports exactly as cleanly positive as
  negative.

## Malformed statements

Banks ship broken CSV. Bank of America writes a raw `"` inside an already
quoted description (`for "may recital"`); usually the stray quotes pair up
and the row still lands in the right columns, but when the phrase between them
contains a comma the row gains columns and every field after the description
shifts left. The amount then becomes a fragment of the description — and a
fragment like `217` parses cleanly, so the row imports as a real transaction
with the wrong sign and the wrong number, with nothing on screen to say so.
Most lines in a long export carry the stray quotes; a couple of them shift.

Three rules hold that line, and none may be relaxed into a guess:

- **A row whose column count differs from the header is refused.** Never trust
  a shifted row — it still carries a plausible date and a plausible number.
  The refusal has to come from `errors`, which is why `fingerprint` is null
  whenever `errors` is non-empty: `markDuplicates` derives the row status from
  the fingerprint, so a row with a fingerprint imports no matter what else is
  wrong with it.
- **Overflow folds back into the description** (`repairRagged`), the one
  free-text column a comma can escape from. The row is marked `repaired` and
  shown on a yellow background; repair is never silent.
- **A running-balance column checks every row** (`checkBalanceChain`):
  previous balance + amount must equal this balance. This is the only check
  that catches a row the file never contained, and the independent confirmation
  that a repair produced the right number. It is a warning, not an error — a
  file that legitimately starts mid-history breaks at its first row.

`detectHeaderRow` runs only when the client sends no `headerRow`, so the user's
answer always wins. It requires a fully populated row naming both a date and a
money column; no data row has that pairing.

Two things the header alone cannot tell you, both learned from a Chase
checking export and both of which refused or mis-flagged every row of it:

- **The body decides the width, not the header** (`bodyWidth`). Chase writes a
  trailing delimiter past the last column on every row, so a 7-column header
  sits above a uniformly 8-field body. Measured against the header every row
  looks shifted, `repairRagged` folds the amount into the description, and the
  whole file is refused with the error pointing at the amount column rather
  than the stray comma. Widen only when nearly the whole body is wide and the
  columns past the header are empty: content past the last named column is
  data the header failed to mention, not padding, and a handful of wide rows
  is a handful of shifted rows. Getting this right also keeps a genuine shift
  visible — a 9-field row in an 8-field body still repairs.

  **The width is the mode of the wide rows, and paddedness is judged only on
  the rows at that width.** Taking the narrowest instead lets one shifted row
  inside a padded file decide the file is not padded, because that row carries
  content in the padding slot. The whole file then falls back to the header
  width and *every* row repairs: the amount column reads the balance, the
  balance reads null, and the chain that would have caught it is skipped
  because there is no balance left to chain. Plausible numbers, no error —
  the exact failure this path exists to prevent. Whether it bites depends on
  where the overflow lands, so it hides behind a fixture whose shifted row
  happens to push a blank into that slot.
- **The chain runs in date order, not file order** (`inDateOrder`). BoA lists
  oldest first, Chase lists newest first. Walked forwards, a newest-first file
  breaks on every row but the first, which buries a real gap in noise. The
  direction is decided from the rows' own dates so an unlabelled file still
  checks itself.

## Routing

Real paths (`/account/5`), not `#/account/5`. Routing still happens entirely in
the browser; the server's only job is to answer when someone refreshes on one.

- `serveStatic` falls through to `notFound`, which hands back `index.html` —
  but **only for paths whose first segment is in `APP_ROUTES`**, and only after
  the containment check. "Anything without an extension" was the first attempt
  and it is too wide: `new URL()` normalises `/../../../../etc/passwd` to
  `/etc/passwd`, which resolves safely inside `web/` and then, having no
  extension, came back 200. Nothing leaked, but a path that should 404 stopped
  saying so — and a mistyped `<script src>` answering 200 with a page of HTML
  is the least debuggable failure available.
- `APP_ROUTES` duplicates the `views` keys the `view-*.js` files register,
  because the server genuinely needs to know them. `test/html.test.js` scans
  every frontend file and fails if the two drift.
- The server owns the **first segment only**. `/accounts/1/nope` serves the app
  and `currentView()` falls back; validating whole route shapes server-side
  would put the client's routing rules in a second place to rot.
- Navigation is one delegated click handler on `document`, not per-link
  listeners — views rebuild their markup constantly. It ignores modified
  clicks, new tabs, downloads, other origins, and anything under `/api/`, so
  the CSV export stays a real download instead of being swallowed.

## Frontend

- **Nothing in `web/` talks to storage except an adapter.** `storage-http.js`
  holds the only `fetch()`; `storage-demo.js` answers the same routes from a
  Map; `storage.js` picks one at load and is the only file that declares
  `storage`. `api()` / `post()` / `put()` / `del()` in `core.js` are one line
  each over it, and `exportLink()` is the one place an export control is
  built. The contract an adapter has to provide is written at the top of
  `storage-http.js`.

  The six `<a href="/api/export/...">` scattered across three views are why
  this is a rule and not a preference: they are invisible to a change of
  backend, and you find them one dead button at a time.
  `test/storage.test.js` fails on a second `fetch(` anywhere in `web/` and on
  a hand-written `href="/api/..."`, and pins `exportLink`'s markup character
  for character against what those views used to write out.
- **The picker never falls back.** `127.0.0.1` gets HTTP, anything else gets
  the demo, and `?storage=` overrides — explicitly, typed by a person, which
  is how the demo gets walked on loopback at all. What it must not do is
  probe: a server that is down on `127.0.0.1` has to produce the error the
  views already show for a server that is down, not a second ledger quietly
  appearing with sample numbers in it. Same posture as `paths.js` refusing to
  open an empty book beside a stranded one. There is exactly one `catch` in
  `storage.js` and it ends by replacing the page; `test/storage.test.js`
  fails on a `fetch(` in that file and on a second `catch`.
- **The demo adapter is held against the real one, route by route.**
  `test/demo-store.test.js` runs the same sequence of writes through both —
  the server over HTTP against a throwaway database, the demo over its Map —
  and compares every read. A handler that answers something the views cannot
  use fails there rather than in a browser. Only two things are allowed to
  differ and both are asserted rather than normalised away: `/api/settings`
  (that is how the chrome says which one you are looking at) and the ids
  handed out after a delete, because SQLite reuses a rowid and the demo store
  counts monotonically on purpose.
- **The demo book has one definition, and both consumers open it unchanged.**
  `shared/demo-seed.js` returns table rows with ids already assigned —
  `scripts/seed-demo.js` inserts them verbatim into a SQLite profile,
  `storage.js` hands the same object to `makeMapStore`, and
  `test/seed.test.js` builds it both ways and compares every row of all eight
  tables. Two hand-written fake ledgers drift the first time either is
  touched, and then the demo shows something the app does not do. It is
  deterministic for the same reason — fixed jitter seed, injected `now` and
  `uuid`, and it throws without them.

  **`db_path: null` is what the chrome branches on**, not the profile name:
  amber 示範資料 badge, 備份與匯出 saying the snapshot has nowhere to go
  rather than offering a button that cannot work, and 重設示範資料.

  **The sample statement is generated from today's date**, for the last
  *complete* month, and belongs to no account in the book. Fixed dates are
  wrong twice over: a committed `.csv` outside `test/fixtures/` is refused by
  the pre-commit hook, and a statement dated next month imports ten rows
  perfectly and then moves no balance, because a balance is computed as of
  today.
- **Packing the hosted copy may only copy.** `scripts/pack-demo.js` writes
  `dist/`: every file byte for byte out of `web/` and `shared/`, plus exactly
  two additions — the tighter CSP (as a `_headers` file *and* a `<meta>`,
  because they fail in opposite directions) and `<meta name="source-commit">`.
  Nothing is minified, inlined or templated. The moment it transforms source,
  "read the repo, that is what is running" stops being true, and that
  sentence is most of what this project is. `test/pack.test.js` compares
  every packed file against its original and pins the directory listing, so
  a third addition has to be a decision somebody made.

  **The commit stamp is an AGPL §13 obligation, not a nicety.** A hosted copy
  is a modified version served over a network, so its users must be
  prominently offered the source *of the version they are running* — hence a
  commit rather than a branch, the link in the sidebar rather than on the
  settings page, and the packer refusing a dirty tree. A link that resolves
  to code somebody is not running is not an offer of source.
- **Build markup with the `` html`` `` tag from `web/html.js`, and put it in the
  document with `mount(el, tpl)`.** Interpolated values are escaped unless they
  are themselves `` html`` `` output, so the safe thing is what happens when you
  do nothing. Never assign `innerHTML` directly and never call `esc()` by hand —
  `test/html.test.js` fails the build on either.
- Arrays of templates interpolate directly; **do not `.join('')`**. A leftover
  join collapses templates into a plain string that then gets escaped, so it
  surfaces as visible tags rather than as an injection. Joining non-markup
  (SVG path numbers) is fine and needs a comment saying so.
- `raw()` is the only escape hatch and every use needs a comment justifying it.
- Modal titles and toasts go through `textContent` and need none of this.
- Charts are hand-built inline SVG. No chart library, no CDN.
- One render function per view in `views`; `render()` re-runs the current one
  after every mutation. There is no client-side cache to invalidate.
- **Nothing diffs, so every re-render has to put the focus back.** Replacing a
  container's markup replaces the focused node, and without `captureUi()` /
  `restoreUi()` typing in the transactions search and pressing Enter drops the
  caret — you have to click back in to change a letter. The pair also restores
  the window scroll and the sidebar account list's own scroll, which is redrawn
  on every render too. Any other path that rebuilds a container outside
  `render()` needs the same bracket; `test/html.test.js` checks the two that
  exist. `focus({ preventScroll: true })`, or focusing something below the fold
  undoes the scroll that was just restored, and `selectionStart` goes in a
  try/catch because number and date inputs throw on it.

**One file per route, and `index.html` is the dependency graph.** There is no
bundler, so the `<script>` list is the only thing deciding what exists and in
what order. Four rules, all enforced by `test/html.test.js` rather than by
memory:

- `html.js` first, `core.js` before any view, `app.js` last — it calls
  `render()` at the bottom, so every `views.*` has to be registered by then.
  Every `.js` in `web/` must appear in the list: one that does not is not a
  broken view, it is a view that silently does not exist, and the router falls
  back to the overview without a word.
- These are classic scripts sharing **one global scope**, so the same
  top-level name in two files is a `SyntaxError` at load and a blank page. The
  test compiles the files concatenated in `index.html`'s order — what the
  browser actually does — because each file parses perfectly well alone.
- **A helper moves to `core.js` / `tables.js` / `forms.js` when a second file
  needs it, not before.** `accountTable`, `institutionForm` and `holdingForm`
  each have exactly one caller and stay with their view; `captureUi` /
  `restoreUi` are in `core.js` because `render()` and `runPreview()` both
  bracket with them. Promoting on the guess that something will be shared is
  how a shared file becomes the new `app.js`.
- A new view is three edits, not one: its `view-*.js`, its `<script>` tag, and
  its name in `APP_ROUTES` in `server/index.js`. The test pins the third to
  the `views` object so a route that renders but 404s on refresh cannot ship.

`view-import.js` is four times the size of any other view and that is honest:
it is the only flow whose state outlives a render. Reach for a further split
when a view grows a second such flow, not because of its line count.

## Styling

`web/style.css` opens with one `:root` block and **every colour, space, size and
radius in the file comes out of it**. No raw hex, no magic number, no
`!important` below that block. A value that appears twice is a token that was
missing. The app is **dark only** — there is no light theme and no toggle; a
light one would be a second `:root[data-theme]` block redefining the same names
and nothing else, which is the point of keeping the layer complete.

**Green and red belong to money.** That is the rule the old palette broke:
`--accent` was one green serving as both the brand (primary buttons, active nav,
chart line, the local badge) and "this number is positive", so an affordance and
a gain were indistinguishable — and `.danger` was the same red as `.neg`, which
put a red delete button beside a column of red numbers. So:

- `--up` / `--down` are for signed amounts. **Green is never an affordance** —
  never a button, link, nav state or brand mark. Red additionally marks hard
  failure (a row that will not import, an error toast), which is universal and
  fine; what it may not be is the resting state of a control. A destructive
  button is neutral until `:hover` / `:focus-visible`.
- Green outside an amount is allowed only for "added / succeeded" (the `新`
  chip, an ok toast) and only next to a word that says so. Colour is never the
  only signal: `signed()` already writes the sign, and status chips carry text.
- `--brand` is the blue. Everything interactive is brand.
- A **level** (a balance, a net worth, a balance-after-import) is coloured only
  when negative — colouring every positive balance green leaves the negative
  ones no louder than the rest, which is the only thing colouring a balance is
  for. A **delta** (a transaction, change vs last month, unrealised P/L, the
  net of an import) is news in both directions and is coloured both ways. Two
  helpers in `core.js`, `level()` and `cls()`; pick by which one it is, not by
  which reads better.

**Every value is measured, not chosen.** Text is ≥ 4.5:1 against every surface
it sits on, and a control border ≥ 3:1 (WCAG 1.4.11). The comment beside each
token carries its ratio; if you change a token, recompute it. What this
replaced: `--text-3` at 3.68:1 (table headers, every `.dim`, every `.muted`),
row hover at 1.03:1, input borders at 1.64:1, a focus border at 1.66:1 against
its own resting state, and `tr.dup` dimmed with `opacity: .45` — which drops the
text to ~3.6:1, unreadable, when reading it is exactly how you judge whether the
row really is a duplicate.

- **Focus is one rule for the whole app**: `:focus-visible` gets
  `outline: 2px solid var(--brand)` at `2px` offset. Never `outline: none`
  without a replacement in the same declaration. Buttons and links previously
  had no focus style at all, so keyboard use was invisible.
- **Pills are for status, not for repeating a column header.** `轉帳` is a
  status. Account kind and currency are not — the column already says so.
- `.note` has four severities and they must stay distinguishable by icon and
  wording, not by tint alone: `.note` (info — explains why a number is what it
  is), `.warn` (proceeds, but look), `.err` (blocked or refused), `.ok`.
  Lumping every warning into one amber `⚠︎` block is what this replaced.
- **The `--marker` leading bar means one thing: a status this row carries and
  the reader did not choose.** An import row that will not import, a coverage
  month whose balance check disagreed. It is not for *where you are* — nav and
  selection are a tinted pill plus `aria-current`, because a bar beside every
  active thing turns the sidebar into a column of stripes and stops meaning
  anything — and it is not added next to an icon that already says the same
  thing, which is why `.note`, the todo rows and the toast have none. Before
  this it was on all seven, which is how it came to say nothing.

**No colour is written in JavaScript.** `lineChart` emits its gradient stops and
its end marker with no colour at all and `.chart stop` / `.chart circle` supply
it; `BAR_COLORS` holds `var(--chart-N)` strings, not hexes. A breakdown is not
seven categories, it is assets against liabilities — a diverging scale, so the
`--chart-N` ramp is the asset pole and `--down` is the other, one hue stepped
by lightness. Every row is already labelled with its own name and number, so
colour carries size, not identity; a fifth asset kind folds into "other"
rather than getting a new hue. Grep `web/` for `#` before claiming the palette
is in one place — a hex in the JS is invisible to every check the stylesheet
makes on itself.

The frontend still writes ~54 inline `style=` attributes. Those are the
remaining styling debt, and the split made them countable: 25 of them are in
`view-import.js` alone, so that is where the debt actually is.

## Schema changes

**A schema change is one appended entry in `server/migrations.js`.** Nothing
else — `db.js` issues no DDL of its own, and there is no SCHEMA string to keep
in step.

```js
{ version: 3, name: 'what it does', up(db) { db.exec('ALTER TABLE …'); } }
```

`server/migrate.js` applies it at `require('./db')` time, so there is no route
into the ledger that skips it. Existing databases in the wild are the user's
real data; the rules below are what keeps that true, and none of them is
advisory.

- **Append, never edit.** An applied step is history. Editing step 2 changes
  what somebody's ledger was already told it had, and no code anywhere will
  notice. The test `補跑上來的帳本和全新建立的帳本，schema 完全一樣` is what
  makes that mechanical: it builds one database by replaying the whole chain
  and another the way an existing book got there, and compares `sqlite_master`.
  Edit step 1 and the two stop matching.
- **Versions are 1, 2, 3 with no gaps.** Two people appending `version: 3` at
  once is caught at startup rather than by one of the steps silently never
  running.
- **A step moves no rows unless it says so.** The runner counts every table
  before and after, inside the transaction, and refuses a difference. A step
  that is *meant* to backfill supplies `verify(db, before, after)` and asserts
  the right post-state itself. There is deliberately no boolean that turns the
  check off: an escape hatch you take by typing `true` becomes the default the
  first time somebody is in a hurry.
- **A step that rewrites a table sets `rebuild: true`.** `PRAGMA foreign_keys`
  is a no-op inside a transaction, so the runner toggles it outside and runs
  `PRAGMA foreign_key_check` inside — a rebuild that orphaned rows rolls back
  rather than being reported about a database already written.
- **The version bump is in the same commit as the change.** That is the whole
  resume story: killed mid-run, the book comes back at the last version that
  completed, with the failed step entirely absent. It is also why `up()` must
  never issue its own `COMMIT`; the runner checks `db.isTransaction` and
  refuses if it did.
- **`up()` may not be `async`.** Nothing in the runner awaits, so a returned
  promise means the counts are taken, the version is stamped and the
  transaction commits while the step's actual work is still queued — it then
  runs afterwards with no transaction around it, and a failure there leaves
  the book claiming a version it never reached with nothing left to re-run.
  This is not hypothetical; it is what happened before the check existed. The
  runner refuses a thenable return.
- **A snapshot is taken before the first step** of any upgrade to a book that
  already has rows — never for a brand new file, which has nothing to lose.
- **A book newer than the code is refused, not opened.** `db.js` prints what to
  do and exits 1, the same posture as the stranded `data/finance.db` guard.

Step 1 is today's schema verbatim and is frozen. It keeps every
`IF NOT EXISTS` it has, because a book that has the tables and lost its
`schema_version` stamp reads as version 0 and replays it.

## Phase 2 seams — do not remove

`txns.source` (`manual` | `csv` | `api`) and `txns.external_id` exist so broker
sync can land beside CSV rows without a schema rewrite. Same for
`holdings.price_date`.

**Done:** the opt-in daily close fetch (`server/prices.js`, Yahoo) writes
`prices` rows with `source: 'api'`, off by default, server-side. Direction is
now a visualisation dashboard driven by the user's own statement numbers, not a
computation engine — no derived cost basis, realised P/L, or XIRR (deliberately
dropped 2026-09-22). Broker *position* sync (upload a holdings statement to
update the numbers) is the next candidate, not transaction-derived lots.
Taiwanese **banks** stay CSV-only — Plaid has no Taiwan coverage, open banking
phase 3 is not open to individuals, and scraping one's own online banking hits
OTP and violates the terms.

## Docs

`README.md` is the front door and stays short: what this is, how to run it, the
first import, and links onward. Anything a reader needs only once it is running
lives in `docs/`, one file per subject, and **the edit goes in the file that owns
the subject, in the same change as the code**:

- `docs/formats.md` — every supported statement, what differs between them, and
  the four traps where a file parses cleanly and the numbers are still wrong.
  A new bank, a new column spelling or a change to any `csv.js` stage lands here.
- `docs/money.md` — the amount conventions, the coverage grid's four states,
  and the table list. A schema change lands here.
- `docs/spending.md` — the spending breakdown, the categorisation rules, the
  recurring-charge detector and budgets. A change to `shared/rules.js` or
  `shared/spending.js` lands here.
- `docs/data.md` — where the ledger lives, profiles, backups, keeping data out
  of version control.
- `docs/security.md` — the three request guards and the CSP, and what each stops.

`docs/design/` is a record of design comps — history, not spec — and
`docs/plans/` holds work not yet done. Neither is a place to document behaviour.
