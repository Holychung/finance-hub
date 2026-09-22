# Plan — crypto and retirement accounts

A PR-by-PR plan for holding two kinds of asset the ledger currently cannot describe
honestly. Written 2026-09-21 against `038bf1f`, when the suite was **396 tests across 66
suites**.

Meant to be picked up by a session that was not present when it was written. Start with
*Check this plan still holds*, then read the PR you are doing.

Every PR follows the project workflow: a worktree beside the repo, a PR, a merge, then
delete the worktree and the branch. See the project memory and `CLAUDE.md`.

---

## The decision this plan encodes

**Net worth today answers one question, and it is being asked two.** Everything in the
book is summed into one figure per currency: a checking balance, a brokerage position, a
credit card. That works because all three are the same *kind* of claim — money you could
have this week.

A retirement account is not. Neither is a staked coin with a 21-day unbonding period.
They are yours, they have a value, and **you cannot spend them**. Adding them to today's
total would make the headline number go up by an amount you have no access to, which is
the same failure as a cross-currency total: a figure that looks like a fact and is not.

So this plan is not "two more account kinds". It adds **one property the model is
missing — whether you can reach the money — and then the two asset classes fall out of
it.**

Three rules follow, and none may be softened:

- **Face value, never discounted.** A pre-tax retirement balance is worth less than it
  says, after withdrawal tax. How much less depends on a rate nobody knows, at a date
  nobody knows. Applying one turns a fact into an estimate that silently moves — exactly
  what `netWorth` already refuses to do with FX. Report the balance the institution
  states, and say it is pre-tax.
- **Unvested is not yours, and that one *is* knowable.** An employer match with a vesting
  schedule has a number attached that the plan document states. That is a fact, so it is
  subtracted rather than annotated.
- **Liquidity is a property of the account, not a new kind.** A self-custody wallet is as
  liquid as a checking account. A locked staking position is not. Retirement is not.
  Encoding it as an account kind would mean guessing from the kind, and the guess would
  be wrong for the cases that matter.

---

## Check this plan still holds

The repo moves quickly. Run these first and adjust rather than trusting the numbers
above.

```sh
node --test 2>&1 | grep -E '^# (tests|suites|pass|fail)'   # baseline was 396 / 66
grep -rn "'cash', 'brokerage'" web/ server/ shared/        # the kind list, duplicated
grep -n 'by_kind\|securities' shared/money.js              # where the total is built
grep -n 'REAL' server/migrations.js                        # the precision problem, PR 2
git log --oneline -5 -- shared/money.js                    # has someone else moved this?
```

**Check `holdings-prices` or any branch touching `holdings` first.** This plan changes
that table in PR 3; a session working on prices is in the same file.

---

## What it costs, honestly

**The account kind list lives in six places.** `server/migrations.js` (a comment),
`web/core.js` (`KIND_LABEL` and `KIND_ORDER`), `web/forms.js`, `web/view-import.js`,
`web/storage-demo.js`, and `server/api.js`'s default. Adding a kind today means six edits
and nothing fails if you miss one — the account simply renders with a raw English key.
PR 1 fixes that before anything else needs it.

**`holdings` assumes equities.** `shares`, `avg_cost`, `market` (`TW` | `US`). A coin has
no market in that sense and eight decimal places rather than none.

**Amounts are `REAL`.** Eight columns, and 49 `round2()` calls keeping the float honest
at every boundary. Two decimal places survive that; eight is at the edge of a double's
significant digits once values are large. This plan does **not** convert the ledger to
integer minor units — that is its own project — but PR 2 stops the precision being
hardcoded at 2, which is the part that would otherwise have to be undone.

---

## The PRs

Six. PR 1 is worth landing even if the rest is abandoned. PRs 2–3 are the model; 4–6 are
the two asset classes and what they need to be readable.

```
PR 1 ── one list of account kinds          independent, do first
PR 2 ── precision per currency/asset       blocks 4
PR 3 ── liquidity on the account           blocks 5, 6

           PR 4 ── crypto
           PR 5 ── retirement
           PR 6 ── net worth reads in two halves
```

---

### PR 1 — One list of account kinds

**Goal.** Make adding a kind a one-file change.

**Approach.** A single exported list — `shared/kinds.js`, beside `shared/rules.js` — with
the key, the display label, the sort position, and whether it is a liability.
`LIABILITY_KINDS` in `shared/money.js` moves into it. Everything else imports it, and
`web/storage-demo.js` and `web/forms.js` build their `<option>` lists from it rather than
from array literals.

**Verification.** A test that walks every kind in the list and asserts it has a label, a
position and a liability flag; and one that greps `web/` and `server/` for an array
literal containing `'brokerage'`, which is what a seventh copy would look like. The
existing suite must pass unchanged.

**Size.** Small.

---

### PR 2 — Precision stops being 2

**Goal.** Let an amount be something other than two decimal places, without converting
the ledger to integers.

**Current state.** `round2()` is defined once in `shared/money.js` and called 49 times,
and `money()` in `web/core.js` formats to 0 or 2 places by currency. Both hardcode the
scale. The dedup fingerprint uses `.toFixed(2)`, which is **frozen** — see the dedup
contract in `CLAUDE.md`; it may not change without migrating every stored fingerprint,
and a statement will never carry a coin amount anyway.

**Approach.** `round2(n)` becomes `roundTo(n, dp)` with `round2` kept as the two-place
case, so the 49 call sites move in one mechanical pass and the fingerprint's `toFixed(2)`
is untouched by construction. Display precision comes from the currency or the asset
rather than a ternary on `'USD'`.

**Where the line is.** This PR does not make float money exact. It makes the *scale* a
parameter so that the conversion to integer minor units, when it happens, is a change of
storage rather than a change of every call site. Say so in the PR; someone will
reasonably ask why it stops there.

**Verification.** New: 8-dp values round-trip through `roundTo` and format correctly;
`round2` behaves exactly as before. Existing suite unchanged.

**Size.** Medium — mostly mechanical, with one decision (where does `dp` come from) that
PR 4 depends on.

---

### PR 3 — An account says whether you can reach the money

**Goal.** The property the whole plan rests on.

**Approach.** Migration step: `accounts.access TEXT NOT NULL DEFAULT 'liquid'`, one of
`liquid` | `restricted`. `liquid` is everything that exists today, so every book upgrades
with its numbers unchanged — which is the test.

`restricted` means *there is a rule between you and this money*: an age, a notice period,
a penalty. Not "hard to sell" — an illiquid property is still liquid by this definition,
because nobody is stopping you.

**Deliberately two values, not a scale.** A number of days until access would be a
guess dressed as data for almost every account that has one.

**Verification.** A v3-shaped book migrates with `access = 'liquid'` on every row and an
unchanged net worth. `computeNetWorth` gains no behaviour yet — that is PR 6 — so the
whole existing suite must pass untouched.

**Size.** Small.

---

### PR 4 — Crypto

**Goal.** Hold a coin without lying about it.

**Approach.** A wallet is an account of kind `wallet` with no institution — the FK is
already nullable. `holdings` gains `decimals` (default 2, so equities are unaffected) and
`market` gains a value; check whether renaming it to `venue` is worth the migration or
whether `market = 'crypto'` is enough, and say which in the PR.

A coin is valued in a currency like everything else, so a BTC position priced in USD
lands in the USD column and needs no new machinery. There is no price feed — `last_price`
is typed in, same as an equity today, and `price_date` already exists to say how stale it
is.

**What makes this honest rather than a checkbox:** a staked or locked position is
`restricted` on its account, so PR 6 reports it apart from the wallet you can spend from
today.

**Out of scope.** On-chain reading of any kind. That is a network call, and the whole
posture around outbound calls is an unmade decision — see *Deferred*.

**Verification.** A fixture wallet with an 8-dp position: the quantity survives a
round-trip through the API and the formatter, the market value lands in the right
currency, and a `restricted` wallet does not join the spendable total.

**Size.** Medium.

---

### PR 5 — Retirement accounts

**Goal.** A 401k, a 勞退 or an IRA that reads as what it is.

**Approach.** Kind `retirement`, `access = 'restricted'` by default. Two fields the
existing model has nowhere to put:

- `tax_status` — `pretax` | `roth` | `aftertax`. Displayed, never arithmetic. The whole
  point is to say the balance is pre-tax without guessing what tax.
- `unvested` — an amount, default 0, **subtracted from the balance**, because it is not
  yours and the plan document states the figure.

Contributions arrive as ordinary transactions; employer match is one more inflow with its
own category. Nothing new is needed there.

**The thing to get right.** A retirement account usually has no per-transaction
statement — you get a balance and a list of funds. That is what `balance_checks` and
`opening_balance` are already for, and it is worth saying in the UI that this account is
expected to be maintained that way rather than imported. `/coverage` should not report an
account nobody can import as a wall of gaps: decide whether `restricted` accounts are
excluded from the grid or shown with their own state, and write down which.

**Verification.** Unvested is subtracted, a Roth and a pre-tax account of the same
balance produce the same arithmetic and different labels, and the coverage grid does what
the PR decided.

**Size.** Medium.

---

### PR 6 — Net worth reads in two halves

**Goal.** The payoff: one number stops pretending to be two.

**Approach.** `computeNetWorth` reports, per currency, `spendable` and `restricted`
alongside the existing total — never a single figure that hides the split. The overview's
per-currency card grows a second line, and the by-kind breakdown separates them rather
than stacking them in one bar.

**What not to do.** Do not discount the restricted half by a tax rate, do not annualise
it, do not project it. The reason is written at the top of this plan and is the same
reason there is no cross-currency total.

**Verification.** A book with one checking account and one retirement account: the two
halves add to the old total, the old total is still reported, and no rate of any kind
appears in the calculation.

**Size.** Small to medium — the arithmetic is trivial; the presentation is the work.

---

## Decisions for the owner, not to be picked unilaterally

1. **Does the headline figure stay the combined total, with the split beneath it — or
   does the spendable half become the headline?** The second is more honest and will read
   as a large drop the day a retirement account is added. My recommendation is the first,
   with the split immediately under it, because the number is not wrong; it was only ever
   under-labelled.

   *Answered 2026-09-22:* the spendable half is the headline, because that is what the
   page is opened to find out, with a 可動用／受限制／全部 switch, since the halves are
   usually looked at separately. The half not on screen is named under the headline, so
   neither is ever hidden. A segmented control rather than a button cycling through three
   states: every option stays visible, and each is one click away.
2. **`market` → `venue` on `holdings`, or a third `market` value?** A migration for
   clarity, against living with a column whose name stopped being true.
3. **Does `/coverage` show restricted accounts?** They have no statements to import, so
   every month is a gap by construction.

   *Answered 2026-09-22:* the question was never about access. A wallet is liquid and
   has no statements either. An account with nothing to import is kept by hand, only its
   latest figure matters, and it leaves the grid and every count, named under the grid
   so it does not silently vanish. Keyed on the kind's `statements` flag in
   `shared/kinds.js`: wallets first, retirement when it is needed.

---

## Explicitly out of scope

- **Price feeds, exchange APIs, on-chain reads.** Every one is an outbound call, and this
  project's posture on those is an open question bigger than this plan.
- **Converting money to integer minor units.** PR 2 makes it cheaper; it does not do it.
- **Tax computation of any kind.** Realised gains need the lot model, which is somebody
  else's branch, and tax rates are not this app's business.
- **Vesting schedules.** One `unvested` figure that the user updates, not a model of the
  schedule that produces it.

---

## Deferred: the outbound-call posture

Recorded so the reasoning is not lost. Four things this plan stops short of — a coin
price, a fund price, an exchange balance, an on-chain balance — are the same thing: the
first outbound call. `test/deps.test.js` currently fails the build on any external URL,
and the CSP ships `connect-src 'self'` locally and `'none'` hosted.

The shape that would preserve the claim: **the browser never talks to anyone; the Node
process does.** Off by default, one allowlist file that the dependency test reads instead
of refusing everything, every call written to a table the user can read, and a standing
indicator in the chrome beside the profile badge. That is a plan of its own, and it is a
positioning decision before it is a technical one.
