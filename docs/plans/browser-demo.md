# Plan — run Finance Hub in a browser, as a demo

A PR-by-PR plan for making the app run with no server, hosted as a public demo that
opens with numbers already in it. Written 2026-09-21 against `840dfdd`, when the suite
was **192 tests across 30 suites**.

This file is meant to be picked up by a session that was not present when it was
written. Start with *Check this plan still holds*, then read the PR you are doing.

Every PR here follows the project workflow: a worktree beside the repo, a PR, a merge,
then delete the worktree and the branch. See the project memory and `CLAUDE.md`.

---

## The decision this plan encodes

**Hosted is a demo, not a ledger.** It opens with sample data, shows what the app does,
and lets a visitor drag in their own statement to watch it parse. It is not somewhere
anyone keeps their books.

This is not a limitation of the implementation, it is a property of browsers. All
script-writable storage is evictable: Safari clears it after roughly seven days without
interaction with the site, every browser evicts under disk pressure, and "clear browsing
data" takes it without telling the user what was in there.
`navigator.storage.persist()` can ask for an exemption and can be refused. A ledger
someone typed in over years cannot live somewhere with those rules.

What follows from that, and why this plan is much shorter than a browser-ledger plan
would be:

- **no IndexedDB** — an in-memory store seeded with sample data is enough, and it resets
  on reload, which is the honest behaviour for a demo
- **no migrations in the browser** — the demo's data is shipped with the code
- **no File System Access API**
- **no fight with eviction**

The real ledger stays where it is: `node server/index.js` against SQLite in
`~/.finance-hub/`. The demo's job is to make someone want that.

If the demo is ever upgraded into a browser-resident ledger, see *Deferred* at the end —
the seam introduced in PR 5 is what makes that an addition rather than a rewrite.

---

## Check this plan still holds

The repo moves quickly; this plan went stale twice while it was being written. Run these
first and adjust rather than trusting the numbers above.

```sh
node --test 2>&1 | grep -E '^# (tests|suites|pass|fail)'   # baseline was 192 / 30
grep -c 'fetch(' web/*.js                                   # the seam: expect exactly one, in core.js
grep -cE 'db\.prepare|db\.exec' server/csv.js               # expect 0 — csv.js must stay DB-free
grep -n 'crypto' server/csv.js server/money.js              # see PR 4's blocker
tail -3 web/html.js                                         # the dual-environment pattern PR 4 copies
```

---

## Why this codebase is ready

Three facts, all verifiable with the commands above. They are why this is a few weekends
and not a rewrite.

**1. The whole frontend has exactly one `fetch()`**, in `web/core.js`. Every view goes
through `api()` / `post()` / `put()` / `del()`, which all funnel into it. That single
call is the entire boundary between the UI and storage. There is no hunting to do.

The exceptions are six `<a href="/api/export/...">` download links in
`view-transactions.js`, `view-holdings.js` and `view-settings.js`. They are real
navigations, not fetches, and PR 5 has to bring them through the same seam.

**2. `server/csv.js` is 837 lines with zero SQL.** The hardest and most valuable code in
the project — Big5 detection, ROC dates, Bank of America's stray quotes, Chase's trailing
delimiter, the balance chain — is already pure functions over strings. It moves to the
browser essentially unchanged. `CLAUDE.md` made that a rule for unrelated reasons; the
payoff lands here.

**3. `web/html.js` already solves dual-environment loading.** Its last three lines assign
the module's exports onto the global *and* onto `module.exports` when `module` exists. No
bundler, no ESM, no build step. PR 4 copies that.

And the SQL, when it does appear, is simple: no window functions, no CTEs, no `HAVING`.
Joins are foreign-key lookups to `accounts` for a name or a currency. Aggregation is
`SUM(amount) GROUP BY account_id` and `COUNT(*) GROUP BY fingerprint`. `money.js` already
pulls whole tables into JS and computes there.

---

## The PRs

Seven. PRs 1 and 2 are independent of everything else and can be done at any time. PRs 3
and 4 are worth landing even if the demo is abandoned. PRs 5 to 7 are the demo itself.

```
PR 1 ─┐
PR 2 ─┴── independent, do whenever

PR 3 → PR 4 ──── worth having regardless

              PR 5 → PR 6 → PR 7 ──── the demo
```

---

### PR 1 — LICENSE and a version tag

**Goal.** Make the repo legally usable by anyone at all.

**Why it is first.** There is no `LICENSE` file. Under copyright that means all rights
reserved: nobody may legally use, modify or redistribute this, demo or not. Every step
towards other people depends on it, and it takes ten minutes.

**Decided: AGPL-3.0-or-later**, copyright Harry Chung. The choice needed the owner and
got it; this is the record, not a question still open.

- **MIT** — permissive, anyone may do anything including closing a fork.
- **AGPL-3.0** — anyone hosting a modified version must publish its source. Worth
  weighing here specifically, because this project's pitch is that you can read all of
  it — about 5,100 lines of source at the time of writing — and verify the privacy
  claims yourself. AGPL is the licence that keeps that true of forks; MIT does not.

The consequence lands on PR 7, which is where the first hosted modified version appears.
See the §13 paragraph there before starting it.

**Also in this PR.** A README section saying plainly what the app is and is not, and
`git tag v0.1.0`.

**Verification.** No tests to run; it is documentation. What it does need is that every
sentence in that new section is true of the code, which is not the same thing as it
reading well — the first draft claimed 「一台機器一本帳」 against a `FINANCE_PROFILE`
feature the same README documents 250 lines further down, and repeated a stale line
telling first-time users that without an FX rate their foreign-currency accounts cannot
be converted, which nothing in the app has done since conversion was removed. Check the
claims against `server/`, not against the rest of the README.

**Size.** Minutes.

---

### PR 2 — Migration runner

**Goal.** Be able to change the schema without destroying someone else's ledger.

**Current state.** `server/db.js` writes `schema_version = 1` once and never reads it
back to migrate anything. `db.js` only issues `CREATE TABLE IF NOT EXISTS`, so a new
column today means a hand-written guarded `ALTER TABLE` — fine when the only database in
the world is yours and you know to back it up first, not fine once there are others.

**Approach.** An ordered list of `{ version, up(db) }`, applied inside a transaction,
with `snapshot()` (already exported by `db.js`) taken before the first one runs. Bump
`schema_version` per step so a half-finished run resumes correctly.

**Precedent to copy.** `scripts/migrate-data-dir.js` already copies a database with
SQLite's `backup()` — not `fs.copyFile`, because under WAL the `.db` file is not the
whole database — and then compares row counts per table. Reuse that check as the
migration runner's own self-test.

**Verification.** Build a v1 database in its own `mkdtemp` directory (per `CLAUDE.md`:
its own directory, not just a unique filename, because `paths.js` derives `BACKUP_DIR`
from the database's directory). Run the runner. Assert the new `schema_version`,
per-table row counts, that a snapshot was written, and that a second run is a no-op.

**Size.** Medium.

**Done.** `server/migrations.js` + `server/migrate.js`, 28 tests in
`test/migrate.test.js` (195/31 → 223/39; 246/43 once `main`'s spending and coverage work
merged in). Four decisions the plan left open, and what they cost:

- **v1 became migration 1, and `db.js` now has no schema of its own.** The alternative —
  a SCHEMA string for fresh installs plus a migration for existing books — means the
  migration only ever runs on other people's ledgers and never in a test run. Here a
  fresh database is version 0 and the whole chain executes on every `node --test`. The
  cost is that "what are the columns today" is the composition of the list rather than
  one readable block; step 1 is that block, verbatim and frozen.
- **The runner applies at `require('./db')` time, so `snapshot()` had to become
  synchronous** — SQLite's `VACUUM INTO` instead of the async `backup()`, bound as a
  parameter so a home directory with an apostrophe in it does not break the statement,
  written to a `.part` and renamed so a killed copy is never offered as a backup. This is
  the one behaviour change outside the new files, and it made the last `async` handler
  synchronous. An async bootstrap in `index.js` was the alternative and it is a promise
  every future caller has to remember.
- **The self-test compares the union of before/after tables**, not the ones that existed
  before — a step that creates a table and fills it is exactly what a before-only
  comparison misses. A step meant to move rows supplies `verify()`; there is no boolean
  that switches the check off.
- **A book newer than the code is refused**, printing what to do and exiting 1, the same
  posture as the stranded-`data/finance.db` guard.

Shipped as migration 3: `idx_txns_import` on `txns(import_id)`. Reverting an import is
`DELETE FROM txns WHERE import_id = ?` and it was the one foreign key on `txns` with no
index. Pinned by `EXPLAIN QUERY PLAN`, not by a row in `sqlite_master`.

Migration 2 is the `rules` table, which landed on `main` while this was in flight as a
`CREATE TABLE IF NOT EXISTS` that stamped `schema_version = 2` on its way past. **That
stamp is why the numbering had to move**, and it is worth knowing about: version numbers
describe books that exist, so a step cannot be given a number some ledger already means
something else by. A book that the earlier build opened has the table and the stamp and
skips step 2; one that predates it gets the table there. Verified against all three
states — v2 with a rule row in it, v1 without the table, and a brand new file.

**The bug this nearly shipped with**, kept because it is the exact shape of failure this
whole PR exists to prevent. Nothing in the runner awaits, so an `async up()` — the habit
every other file here teaches — had the runner take its counts, stamp the version and
commit while the step's actual work was still queued; the DDL then ran afterwards with
no transaction around it. Reported success, wrong database. It is now refused outright,
and the test settles the dropped promise to show the work still happens.

---

### PR 3 — Make `money.js` pure

**Goal.** Separate "fetch the rows" from "compute the answer", so the computation can run
anywhere.

**Current state.** 331 lines, 12 exports, 11 query points — lines 16, 46, 50, 62, 130,
133, 214, 222, 243, 300, 312. Six functions query directly and then compute:
`buildFxLookup`, `accountsWithBalances`, `holdingsValued`, `netWorthSeries`, `reconcile`,
`findTransferCandidates`. `netWorth` issues no query of its own but composes two of them,
so it splits the same way. Two are writes and can stay as they are for now:
`applyTransferPairs`, `unlinkTransfer`.

**The pattern already exists in the file.** `liabilitiesInCredit(accounts =
accountsWithBalances())` on line 201 takes its rows as a parameter and falls back to a
query. This PR generalises that shape to the other seven.

**Keep the exported names and signatures**, so `server/api.js` does not change at all.
Add the pure `compute*` functions alongside, and let the existing functions become thin
`load + compute` wrappers.

**Why it stands alone.** Net worth, cross-currency transfer pairing and reconciliation
are the three things most worth testing, and today testing them means starting a server
and going through a full HTTP round trip. After this they are ordinary function calls
over arrays.

**Verification.** New unit tests for the pure functions. **The existing suite must pass
unchanged** — if an existing test needs editing, behaviour moved and the PR is wrong.

**Size.** Medium.

**Done.** Eight `compute*` functions and eight thin loaders; `test/money.test.js` adds 32
tests, suite 246/43 → 278/53, and **not one existing test needed editing**. The line
numbers above were stale by the time this ran — `money.js` was 461 lines, not 331,
because `coverage` had landed in between. That turned out to help: `computeCoverage` /
`coverage` was already exactly the shape this PR wanted, so the naming convention came
from the file rather than from this document.

- **The convention is the name.** `compute*` is pure, the bare name loads. Two mechanical
  guards in `test/money.test.js` keep it that way: one scans each `compute*` body for
  `db` and fails on a hit, the other fails if a `compute*` has no loader of its own.
- **The first version of that scan was worthless and passed anyway.** It looked for "the
  first `{` after the function name", which for `computeHoldingsValued({ holdings })` is
  the parameter list — so every body it checked was four characters long. Found by
  planting a `db.prepare` in a `compute*` and noticing the suite stayed green. A guard
  you have not watched fail is not a guard, and there is now a test asserting the
  extractor reaches the body.
- **`reconcile` was the awkward one.** It ran one indexed `SUM` per balance check inside
  the map, which is not data the pure half can see. Rather than pull every transaction
  into memory to avoid it, the loader attaches `txn_total` to each check and
  `computeReconcile` destructures it away so the response shape is unchanged. The
  arithmetic that can actually be wrong — opening balance plus movement, a cent of
  tolerance — is what moved.

`applyTransferPairs` and `unlinkTransfer` stay as they are: they are writes, and nothing
needs them pure yet.

---

### PR 4 — `shared/`: one copy of the domain logic, two environments

**Goal.** Let Node and the browser load the same `csv.js` and `money.js`.

**What PR 3 left you.** The pure half is now exactly the `compute*` functions plus
`round2`, `convert`, `monthEnds`, `monthAdd`, `monthsEnding`, `daysBetween`, `todayISO`,
`liabilitiesInCredit`, `LIABILITY_KINDS` and `COVERAGE_MONTHS` — the first group in
`money.js`'s `module.exports`, and the boundary is checked by a test rather than
remembered. `server/rules.js` and `server/spending.js` arrived already pure and belong in
the same move. One thing to fix while moving: `test/money.test.js` has to set
`FINANCE_DB` to a throwaway directory before requiring `money.js`, purely because the
file still pulls in `./db` for the loaders. Once the pure half is its own module that
preamble deletes itself, and that is the cleanest proof the move actually worked.

**Approach.** Move `server/csv.js` and the pure half of `money.js` to `shared/`. Wrap
each in the pattern from the last three lines of `web/html.js`: assign the exports onto
the global, and also to `module.exports` when `module` is defined. `server/*` keeps
`require`-ing them; `web/index.html` gains two `<script>` tags, placed after `html.js`
and before `core.js`.

**⚠ The one real blocker, and it is in this PR.** `server/csv.js` computes the dedup
fingerprint with `crypto.createHash('sha1')`, which is synchronous and Node-only. The
browser has `crypto.subtle.digest('SHA-1', …)`, which is **async**, and the fingerprint
is currently computed synchronously inside a row-mapping loop.

`CLAUDE.md`'s dedup contract says the fingerprint definition cannot change without
migrating every stored fingerprint, so whatever is done must produce **byte-identical**
hashes. Three options:

1. Make fingerprinting async all the way up. Invasive: it reaches `markDuplicates` and
   the whole parse pipeline, which is the code least worth destabilising.
2. **Recommended — write a synchronous SHA-1 in `shared/`, about 40 lines.** This is
   literally the case `CLAUDE.md` describes: "If a task seems to need a library, write
   the 40 lines instead." Correctness is directly testable: hash a corpus with both the
   new implementation and `node:crypto` and assert equality. That test can only run in
   Node, which is exactly where the reference implementation lives.
3. Precompute hashes in one async pass before the synchronous mapping. Less invasive than
   (1), still restructures the pipeline.

`crypto.randomUUID()` in `money.js` needs no work — browsers have it in secure contexts,
and both `127.0.0.1` and `https:` are secure contexts.

**Also update the guards** so they cover the new directory:

- `test/html.test.js` reads `web/` to build its file list — `shared/` must be added, or
  its escaping and dependency-graph guards silently stop covering the moved code.
- `test/deps.test.js`'s `SOURCE_DIRS` must gain `shared`, or the no-external-URL scan
  develops a blind spot.

**Why it stands alone.** CSV parsing becomes testable in a browser, and the import
preview becomes something that *could* run entirely client-side later.

**Verification.** Existing tests unchanged. New: the SHA-1 equivalence corpus, and one
test that a `shared/` module behaves identically under both load paths.

**Size.** Medium — mostly movement, plus the SHA-1.

**Done.** `shared/sha1.js`, `shared/csv.js`, `shared/money.js`;
`server/money.js` keeps the loaders; `test/sha1.test.js` adds 10 tests; 304 tests across
58 suites once the import-period work merged in alongside. Every pre-existing test
passes on behaviour; three changed a `require` path, which a moved file forces.

The import-period work landed in `server/money.js` while this was in flight, adding four
pure helpers and rewriting `computeCoverage`. Resolving that was not hand-merging: the
split is done by a script that classifies each top-level declaration as pure or loader,
so the merge was re-running it over the new file and adding four names to the list. Then
diffing the old file's code lines against both new ones to prove nothing was dropped —
worth repeating whenever this file is split again.

- **The SHA-1 is byte-identical to `node:crypto`**, held there by the standard vectors,
  every length from 0 to 200 (the padding boundary is where hand-written ones break),
  non-ASCII descriptions, three thousand random Unicode strings, and a direct comparison
  of `fingerprint()` against the old `createHash` expression. Option 2 of the three, as
  recommended, and it stayed at sixty lines.
- **`shared/` files are IIFE-wrapped, unlike `web/`'s.** Not stylistic: `csv.js` alone
  declares 36 top-level names, and `round2` already existed in `web/core.js`. Two
  `const`s of one name in the shared script scope is a SyntaxError and a blank page, so
  the closure makes the clash impossible rather than merely detectable. The cost is that
  the move shows up as a whole-file re-indent — read it with `git diff -w`.
- **The dual-load test does what it says.** It runs the shared files in a bare `vm`
  context with no `require` and no `module`, in `index.html`'s order, and compares that
  copy's answers to the required one's: the same fingerprint, the same 玉山 statement
  parsed to the same rows, the same Big5 fallback, the same net worth. That is also the
  check that would catch a stray `node:` import, which no amount of reading would.
- **`shared/` is a second static root**, served under `/shared/` with its own
  resolve-and-compare containment check, and `test/api.test.js` walks `..` out of it.

**What this leaves PR 5.** Two duplications are now *removable* and were deliberately
not removed, because both change what the views render and belong with the PR that walks
them in a browser:

- `web/app.js` still keeps its own copy of `LIABILITY_KINDS`. The test that pins the two
  lists together says in its comment why it existed — the browser could not import from
  `server/money.js` — and that reason is now gone. Deleting the copy means switching the
  call sites from an array to the shared `Set`.
- `web/core.js` still has its own `round2`.

`server/rules.js` and `server/spending.js` are pure already and are the obvious next
things to move; they were left out to keep this PR to what the plan scoped. **Done
afterwards**, along with extracting the CSV formatter — see *PR 6, groundwork* below.

---

### PR 6, groundwork — the rest of the domain logic moves to `shared/`

Not in the original plan; split out of PR 6 once its real size was clear. PR 6's store
has to answer `/api/spending`, `/api/recurring`, `/api/rules` and the CSV export, and
the only honest way to do that in a browser is to run the same code the server runs.
Doing it inside PR 6 would have meant a server refactor buried in an eight-file demo
adapter.

`shared/rules.js` and `shared/spending.js` are `git mv` plus the dual-environment
wrapper — both were already pure and required nothing but each other.
`shared/export.js` is the extraction that had content: `exportCsv` mixed the formatting
with a query, so the formatter takes rows now and `server/index.js` keeps the part only
a server can do, which is loading them and naming the download.

**The `折基準幣` column is gone from the accounts CSV.** It read `a.balance_base`, a
field nothing has set since currency conversion was removed — `test/api.test.js`
already asserted the field was absent from the API while the export went on writing an
empty cell under a header promising a converted figure. It survived because only the
transactions export had a test, and only for its BOM. `test/export.test.js` now covers
all three sheets' columns, the escaping and the bytes, and an end-to-end test asserts no
exported row has a trailing empty field.

Every `.js` under `shared/` has to appear in `index.html` — `test/html.test.js` enforces
it and then loads the whole list — so the browser now carries three more files it does
not use yet. That is the same price the plan already accepted for shipping both storage
adapters, and it means the move is checked by something rather than assumed.

329 tests across 62 suites.

---

### PR 5 — A storage interface, with only the existing HTTP implementation

**Goal.** Put a named seam where the single `fetch()` is, without changing any behaviour.

**Approach.** Define the repository contract and implement it once, as
`web/storage-http.js`, doing exactly what happens today. `core.js`'s `api()` / `post()` /
`put()` / `del()` delegate to it.

Bring the six `<a href="/api/export/...">` links through the same seam as a `download()`
helper — in the demo there is no server to serve a file, so they have to become a Blob.
Finding them later, one by one, is how a demo ships with three dead buttons.

**Why it stands alone.** The contract gets written down and tested; the user sees no
change; risk is near zero. It is also the natural place to document what storage must
provide, which is the thing PR 6 implements against.

**Verification.** Full suite green, plus the seven views walked in a browser. Pay
attention to the export buttons.

**Size.** Small to medium.

**Done, except the browser walk.** `web/storage-http.js` holds the contract and the one
`fetch()`; `api`/`post`/`put`/`del` are a line each over it and `exportLink()` is the
only place an export control is built. `test/storage.test.js` adds 9 tests; 304/58 →
315/60.

- **The six export links were the point**, and they are now one function. The markup
  `exportLink` produces is pinned character for character against what the three views
  wrote by hand, including which of them carries `download` — the CSV ones deliberately
  do not, because the server names the file with a date stamp in its
  Content-Disposition.
- **Two guards, both watched failing** before being trusted: a second `fetch(` anywhere
  in `web/`, and a hand-written `href="/api/..."`. Planted one of each in a view and
  confirmed both fail and name the file.
- **The two duplications PR 4 left are gone.** `web/core.js` no longer declares
  `LIABILITY_KINDS` or `round2`; the views read the `Set` from `shared/money.js` with
  `.has()`. The parity test that held the two lists in step went with the duplication it
  existed for.
- **`round2` still exists three times** — `shared/money.js`, `shared/csv.js` (so it
  depends on nothing but the hash) and `server/spending.js`. Both shared copies assign
  it to the global, so **whichever loads last wins**; harmless while they agree, and an
  arithmetic difference nobody would look for if they stopped. Now pinned by a test that
  compares the three definitions textually.
- **`test/html.test.js` now runs the frontend, not just compiles it.** All nineteen
  scripts, in `index.html`'s order, against a DOM stub, asserting that `html`, `storage`,
  `round2`, `LIABILITY_KINDS` and `fingerprint` resolve and that all nine views
  registered. That upgrade exists because this PR deleted two globals from `core.js` and
  "compiles" would not have noticed them going missing.

**Still needs a human at a browser.** The suite cannot see rendering. Specifically worth
clicking: the four export buttons on 設定, the one on 交易, the one on 持股, and the
negative-opening-balance warning on the account form and the import form, which is the
code path that changed from `Array.includes` to `Set.has`.

### PR 6 — The demo store

**Goal.** The app runs with no server, opening on data that makes it look alive.

**The simplification the demo buys.** The store is an in-memory object seeded at load and
mutated in place. Writes work — adding a transaction, pairing a transfer, importing a CSV
all behave normally — and everything resets on reload. That is the correct behaviour for
a demo and it needs no persistence layer at all. After PR 3 the computations are pure
functions over arrays, so the "queries" are `filter` and `reduce`.

**One `index.html`, both adapters.** Ship `storage-http.js` and `storage-demo.js` side
by side and let a small `storage.js` pick between them at load. Do not make a second
`index.html` for the hosted build: two copies of the markup drift, and there is no build
step to generate one from the other. The unused adapter is a few kilobytes of dead
weight in each deployment, which is the right price. `test/html.test.js` already
requires every `.js` in `web/` to appear in `index.html`, so this is the shape the guards
push you into anyway.

**Choosing the adapter: decide by origin, and never fall back silently.**
`127.0.0.1` / `localhost` → HTTP. Anything else → demo store. If the expected backend is
missing, say so loudly and stop; do not quietly write somewhere else. This project is
consistent about never being vague about where the money is recorded — `paths.js` refuses
to start when it finds a stranded `data/finance.db` rather than opening an empty one, and
the sidebar badge turns amber for a non-personal profile. Same principle.

**Say what it is, in the chrome.** The sidebar badge should read as a demo, in `--warn`,
on the same precedent as the profile badge. A visitor must never be unsure whether what
they are looking at is their data.

**The sample data must be obviously synthetic and generated, not copied.** Do not build
it from a real export — this is a privacy-first project and shipping a demo carved out of
someone's actual Chase statement would be the single worst available mistake. Aim for:

- two or three accounts across TWD and USD, so the per-currency net worth columns appear
  with no grand total — that is one of the app's more distinctive decisions and it only
  shows with more than one currency
- one credit card carrying a negative balance, which demonstrates the liability sign rule
- a brokerage account with holdings, showing that market value sits outside the account
  balance
- about eighteen months of transactions, so the net worth series draws a real line rather
  than two points
- a couple of matched transfer pairs, so the pairing review has something in it
- a balance check and an FX rate or two

Plus a **"reset demo"** control, and a small synthetic CSV a visitor can drag into the
import view. `test/fixtures/` has realistic statements to model the *shape* on; write new
ones rather than shipping those.

**Verification.** The store's logic goes behind an injected raw-store interface so Node
tests can drive it with a plain `Map`. Be explicit in the PR about what that does *not*
cover: the demo path still needs a manual walk through all seven views in a browser, plus
one CSV import end to end.

**Size.** Large. Consider splitting into "store + tests" and "wire it up".

**Done: the store half.** `web/storage-demo.js` answers the 39 routes the frontend
actually calls, `web/storage.js` picks an adapter, and `test/demo-store.test.js` holds
the result against a real server. 329/62 → 371/65. Split three ways in the end rather
than two, because the groundwork above turned out to be a PR of its own.

- **The test that matters runs both.** The same sequence of writes goes through the
  server over HTTP against a throwaway database and through the demo over its Map, and
  then every read is compared — nineteen GET routes field by field, the import preview
  down to each row's fingerprint and status, the commit, the revert, and the error
  messages for five kinds of bad input. "Does it return something plausible" would not
  have caught much; "does it return the same thing" catches everything the views could
  trip over.
- **Two divergences, asserted rather than normalised away.** `/api/settings` differs on
  purpose — that is how the chrome says which ledger you are looking at, and the demo
  reports `db_path: null` rather than inventing a path. And ids diverge after a delete:
  SQLite hands the rowid back to the next insert, the demo counts monotonically,
  because a reused id makes a bookmarked `/account/3` quietly point somewhere else.
  There is a test named for it.
- **The pre-import snapshot has no answer, so it says so.** No filesystem, so
  `/api/backups` is empty and a commit reports `backup: null`, which the import view
  already renders as "no backup". A fake filename would have been worse.
- **The picker's guards were watched failing.** Planting a runtime probe with a
  fallback `catch` trips five tests including the one named for it; treating an unknown
  `?storage=` as absent trips its own. `?storage=demo` exists because the demo cannot
  otherwise be walked on `127.0.0.1`, and the badge appears however it was chosen.
- **`new URL(path, base)` is not available here.** Any base hostname, however
  unresolvable, is a string `test/deps.test.js` has to be argued out of flagging, so
  the router splits the query off by hand. The no-outbound scan being awkward to
  satisfy is the scan working.

**Done: the wiring half (6b).** `shared/demo-seed.js` is now the book, and both the CLI
seeder and the browser open it. 371/65 → 385/66, and 387/66 once the two `main` gained
while this was open merged in.

- **One definition, two consumers.** `buildDemoBook({to, months, now, uuid})` returns
  table rows with ids already assigned — the shape `makeMapStore` takes and the shape
  `scripts/seed-demo.js` inserts verbatim. `test/seed.test.js` builds the book both
  ways and compares every row of all eight tables, so the SQLite ledger and the
  in-memory one cannot drift. Two hand-written fake ledgers would have drifted the
  first time either was touched, and a visitor would be looking at something the app
  does not actually do.
- **Deterministic on purpose.** The jitter runs off a fixed seed and `now`/`uuid` are
  injected — the builder throws without them — so the same call twice produces the same
  book and a test can assert on it.
- **The chrome says which ledger it is.** `db_path: null` is what the settings view
  branches on: the badge reads 示範資料 in amber, 備份與匯出 says the snapshot has
  nowhere to go rather than offering a button that cannot work, and 重設示範資料 rebuilds
  the book in place.
- **The sample statement is generated, not stored.** `buildDemoStatement(to)` writes a
  玉山-shaped file — ROC dates, 支出/存入 as two columns, a running balance, CRLF — for
  the last **complete** month before today. Fixed dates were wrong twice over: a
  committed `.csv` outside `test/fixtures/` is refused by the pre-commit hook, and the
  first draft was dated next month, which imports ten rows perfectly and then moves no
  balance at all, because a balance is computed as of today. It belongs to no account in
  the book, so dropping it in with nothing selected lands in 「從這個檔案建立帳戶」 —
  the flow the import view was built around — and no row can collide with a seeded one.

**Still owed: the browser walk.** Everything above is checked in Node, including the
frontend load order — `test/html.test.js` runs every file in `index.html`'s order and
asserts the globals resolve and all nine views register. That is not the same as looking
at it. All seven views and one end-to-end import still want a human with a browser.

---

### PR 7 — Put it online

**Goal.** A public URL that is honest about what it is.

**Approach.** No build: `web/` and `shared/` are already static files. Copy them, or point
a static host at them.

**Tighten the CSP for the hosted variant to `connect-src 'none'`.** The demo talks to no
server at all, so the page can be made *incapable* of sending anything anywhere — and
unlike a privacy policy, a visitor can confirm it themselves by opening the network tab
or reading the response headers. That is the strongest available version of this
project's central claim, and it costs one line.

**The copy matters as much as the code.** State on the page: this is a demo, the data is
sample data, anything you enter stays in this browser tab and disappears when you reload,
and if you want to keep books, download it and run it locally. Link the repo.

`navigator.storage.persist()` is not needed here — nothing is being persisted. Do not
request it; requesting permission for something you are not doing is its own small lie.

**The link back is now an obligation, not a courtesy.** PR 1 licensed the repo AGPL-3.0,
and the hosted build is a *modified* version — a different CSP, an adapter picker, a
demo badge, seed data — served to people over a network. Section 13 therefore applies:
the page must prominently offer those users the Corresponding Source **of the version
they are using**, so the link has to name the commit or tag it was built from, not just
point at `main`. It also means any change made for the hosted variant has to be
committed rather than applied only as a host header.

Two mechanical consequences, both of which will bite on the way in:

- `test/deps.test.js` scans `web/` for external URLs, so the repo link fails the
  no-outbound guard as it stands. The honest fix is a fourth entry in `ALLOWED_URLS`
  with a comment saying why a user-initiated navigation to the source is not a request
  the page makes — not relaxing the scan, and not a bare host prefix.
- The CSP is `default-src 'none'`, so an `<a href>` is fine (navigation is not a fetch),
  but nothing may be *loaded* from that host.

**Done, except the deploy itself.** `node scripts/pack-demo.js` writes `dist/`; pointing
a static host at it is the step left, and that one needs an account rather than a commit.
387/66 → 398/68.

- **Copying is the whole build, and `test/pack.test.js` holds it to that.** Every packed
  file is compared byte for byte against its original and the directory listing is
  pinned, so the two additions stay two. A third has to be somebody's decision rather
  than something a copy loop swept up.
- **One list, two policies.** `server/csp.js`: the local server needs `connect-src
  'self'` for its own `/api`, the hosted demo has nothing to connect to and says
  `'none'`. The plan called this one line. It is one line plus refusing to keep a second
  copy of the list — the only thing that notices a weakened CSP is somebody reading it.
- **It ships as a header and as a `<meta>`, because those fail in opposite directions.**
  A host that ignores `_headers` still gets the meta; the meta cannot carry
  `frame-ancestors`, which the HTML parser discards. `cspMeta()` drops that directive
  rather than emitting one the browser will throw away: a policy that claims a
  protection it is not applying is worse than one that does not claim it.
- **§13 landed as predicted, plus one thing the plan did not say.** The allowlist entry
  is anchored at both ends rather than left a host prefix, which would also wave through
  a `<script src>`. And the packer **refuses a dirty tree** — the stamp is what the offer
  of source resolves to, so packing uncommitted work publishes a link pointing at code
  nobody is running.
- **Not verified here: the packed page in a browser.** The tests read that directory,
  they do not load it. `python3 -m http.server -d dist` is the cheapest look, and it is
  also the `_headers`-ignoring case, so what it shows is the meta-only floor.

**Size.** Small to medium.

---

## Explicitly out of scope

- **A bundler or a frontend framework.** PR 4 demonstrates they are not needed. The
  zero-dependency rule is enforced by `test/deps.test.js` and `githooks/pre-commit`;
  adding one means deliberately removing a guard.
- **SQLite compiled to WASM.** It would let the schema and all the SQL survive untouched,
  and it is the wrong trade: a large opaque binary destroys the "read it all yourself"
  property that is the entire pitch. (The figure lives in exactly one place, README's
  opening paragraph, so it cannot go stale in two — it was 4,500 when this was written
  and is 5,153 today.)
- **Server-side accounts, stored user data, sync, telemetry.**
- **Making the demo remember anything between visits.** That is the ledger product, and
  it is deferred on purpose.

---

## Deferred: if the demo should become a real browser ledger

Do not build towards this now; it is recorded so the reasoning is not lost.

The seam from PR 5 is the whole point — a second implementation slots in beside
`storage-http.js` and `storage-demo.js` without touching a view. What is then needed:

- **IndexedDB** rather than an in-memory object. At realistic scale — say 50,000
  transactions over a decade, roughly 10 MB — the store can still load everything into
  memory and compute in JS, persisting on write. It does not need indexes, and it is much
  simpler that way.
- **Export and import of a full JSON backup, before anything else.** Telling people to
  keep data somewhere evictable without a working escape hatch is not defensible.
  `/api/export/json` already exists on the server side to mirror.
- **A pre-import snapshot** into a `backups` object store, matching what `snapshot()`
  does with files today.
- **Schema migration in the browser**, which is PR 2's runner over a different store.
- **File System Access API** so the database can be a real file the user picked. Chrome
  and Edge only; a bonus, never the main path.
- And it still would not fix eviction. It would only make the loss recoverable.
