'use strict';

// Build three fixtures describing ONE invented 401(k), 01/01/2024 to 09/18/2026:
//
//   test/fixtures/fidelity-401k-2024.pdf   its NetBenefits "Statement Details" page,
//                                          printed from Chrome the way a person saves it
//   test/fixtures/fidelity-401k-2024.csv   its NetBenefits transaction history, same period
//   test/fixtures/fidelity-401k-2024.json  every figure the statement prints, as numbers,
//                                          plus the PDF's SHA-256 so the two cannot drift
//
//   node scripts/fixtures/fidelity-401k-2024.js      (needs Google Chrome; CHROME=… to point
//                                                     at another build)
//
// Everything is made up — the plan, the person, the funds, every price, amount and date.
// Only the shape is copied: the statement's sections and wording, the history's columns,
// preamble and row order. See test/fixtures/README.md.
//
// The story: auto-enrolled into a target-date fund with a little money market before 2024.
// From 01/01/2024 contributions are invested 80% in an S&P 500 index fund and 20% in a
// growth tech fund, and on 02/09/2024 everything saved so far is exchanged into the same
// 80/20. The deferral lands mid-month, matched at 50%, and steps up each January.
//
// Money is integer cents and shares are integer thousandths of a share throughout, so the
// statement adds up to the cent the way a real one does, and the history's units, summed,
// land exactly on the statement's share counts.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { statementHtml, printHeader, printFooter } = require('./fidelity-statement-html');
const { printToPdf } = require('./print-pdf');

const OUT = path.join(__dirname, '..', '..', 'test', 'fixtures');
const NAME = 'fidelity-401k-2024';

const START = '2023-12-31'; // the statement's "as of" date for opening shares and prices
const END = '2026-09-18';
const AS_OF = '2026-09-19';

const FUNDS = [
  { key: 'sp500', name: 'S&P 500 Index Trust', history: 'S&P 500 INDEX TRUST', cls: 'Stock', sub: 'Large Cap', weight: 80 },
  { key: 'tdf', name: 'Target Date 2055 Trust', history: 'TARGET DATE 2055 TRUST', cls: 'Blended Investment*', mix: { stocks: 90, bonds: 9, short: 1 } },
  { key: 'tech', name: 'Growth Tech Fund', history: 'GROWTH TECH FUND', cls: 'Stock', sub: 'Large Cap', weight: 20 },
  { key: 'mm', name: 'Govt Money Market', history: 'GOVT MONEY MARKET', cls: 'Short Term' },
];
const byKey = Object.fromEntries(FUNDS.map((f) => [f.key, f]));
const CLASS_ORDER = ['Stock', 'Short Term', 'Blended Investment*'];
const MARKET_VALUE_ORDER = ['sp500', 'tech', 'mm', 'tdf'];
const SOURCES = ['employee', 'employer'];
const EMPLOYER_VESTED_PERCENT = 80;

// Month-end prices in cents from 2023-12 to 2026-08, then the price on END.
const MONTHS = [];
for (let y = 2023, m = 12; y < 2026 || (y === 2026 && m <= 9);) {
  MONTHS.push(`${y}-${String(m).padStart(2, '0')}`);
  if (++m > 12) { m = 1; y++; }
}
const MONTH_END_PRICE = {
  sp500: [15000, 15240, 16030, 16520, 15860, 16630, 17210, 17420, 17830, 18210, 18060, 19110,
    18650, 19190, 18910, 17840, 17710, 18820, 19780, 20220, 20650, 21340, 21800, 21840, 21910,
    22290, 21960, 22580, 23120, 23690, 24030, 24510, 24370, 24960],
  tech: [4000, 4180, 4490, 4560, 4310, 4670, 5020, 4810, 4900, 5060, 5010, 5330, 5390, 5310, 5020,
    4540, 4590, 5080, 5470, 5690, 5740, 6120, 6430, 6210, 6280, 6390, 6100, 6420, 6750, 7010, 7260,
    7490, 7340, 7620],
};
for (const k of Object.keys(MONTH_END_PRICE)) {
  if (MONTH_END_PRICE[k].length !== MONTHS.length) throw new Error(`${k}: one price per month`);
}
const TDF_PRICE = { start: 2140, jan: 2162, exchange: 2195, end: 2985 };
const EXCHANGE_DATE = '2024-02-09';
const EXCHANGE_PRICE = { sp500: 15620, tech: 4330, tdf: TDF_PRICE.exchange, mm: 100 };
const TDF_COST = 3730000; // what the target-date shares cost, for its realized gain line

// Before 2024: the defaults held these, owned by the two sources in the ratio the pre-2024
// contributions were made (26,400.00 : 13,200.00).
const PRE_2024 = { employee: 2640000, employer: 1320000 };
const OPENING_UNITS = { tdf: 1961215, mm: 2350180 };

const DEFERRAL = { 2024: 180000, 2025: 190000, 2026: 200000 }; // per month
const MATCH_PERCENT = 50;
const SP500_DIVIDEND = { 2024: 46, 2025: 53, 2026: 58 }; // cents per share, each quarter
const TECH_DIVIDEND = 12; // cents per share, each December
const MM_INTEREST = 1011; // January 2024, the one month the money market was held

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const weekday = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const businessDayOnOrBefore = (y, m, d) => {
  const back = { 0: 2, 6: 1 }[weekday(y, m, d)] || 0;
  return iso(y, m, d - back);
};
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return iso(y, m, lastDay(y, m)); };

const value = (milli, cents) => Math.round((milli * cents) / 1000);
const buy = (cents, price) => Math.round((cents * 1000) / price);
const split8020 = (cents) => {
  const sp = Math.round((cents * byKey.sp500.weight) / 100);
  return { sp500: sp, tech: cents - sp };
};

function build() {
  const units = {};
  for (const s of SOURCES) units[s] = { sp500: 0, tdf: 0, tech: 0, mm: 0 };
  for (const f of Object.keys(OPENING_UNITS)) {
    units.employee[f] = Math.round((OPENING_UNITS[f] * PRE_2024.employee) / (PRE_2024.employee + PRE_2024.employer));
    units.employer[f] = OPENING_UNITS[f] - units.employee[f];
  }
  const total = () => Object.fromEntries(FUNDS.map((f) => [f.key, units.employee[f.key] + units.employer[f.key]]));
  const opening = total();

  const flow = Object.fromEntries(FUNDS.map((f) => [f.key, { employee: 0, employer: 0, exchanges: 0, dividends: 0 }]));
  const history = []; // { date, fund, type, cents, milli, order } — one row of the download each

  // Every event of the period. `order` keeps a day's rows in the download's order.
  const events = [{ date: '2024-01-31', kind: 'interest', month: '2024-01' }, { date: EXCHANGE_DATE, kind: 'exchange', month: '2024-02' }];
  for (const ym of MONTHS.slice(1)) {
    const [y, m] = ym.split('-').map(Number);
    events.push({ date: businessDayOnOrBefore(y, m, 15), kind: 'contribution', month: ym, year: y });
    if (m % 3 === 0 && ym < END.slice(0, 7)) {
      events.push({ date: businessDayOnOrBefore(y, m, lastDay(y, m)), kind: 'dividend', fund: 'sp500', month: ym, year: y });
    }
    if (m === 12) events.push({ date: businessDayOnOrBefore(y, m, lastDay(y, m)), kind: 'dividend', fund: 'tech', month: ym, year: y });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  const i = (ym) => MONTHS.indexOf(ym);
  const midMonth = (fund, ym) => Math.round((MONTH_END_PRICE[fund][i(ym) - 1] + MONTH_END_PRICE[fund][i(ym)]) / 2);
  const priceOn = (fund, ym) => MONTH_END_PRICE[fund][i(ym)];
  const valueAt = (ym) => {
    const t = total();
    let v = 0;
    for (const f of FUNDS) {
      if (!t[f.key]) continue;
      const p = f.key === 'mm' ? 100 : f.key === 'tdf' ? (ym === '2023-12' ? TDF_PRICE.start : TDF_PRICE.jan) : priceOn(f.key, ym);
      v += value(t[f.key], p);
    }
    return v;
  };

  const monthValue = { [MONTHS[0]]: valueAt(MONTHS[0]) };
  const monthFlow = {};
  for (const [n, e] of events.entries()) {
    if (e.kind === 'contribution') {
      const employee = DEFERRAL[e.year];
      const bySource = { employee, employer: Math.round((employee * MATCH_PERCENT) / 100) };
      const bought = { sp500: { cents: 0, milli: 0 }, tech: { cents: 0, milli: 0 } };
      for (const s of SOURCES) {
        const parts = split8020(bySource[s]);
        for (const f of ['sp500', 'tech']) {
          const milli = buy(parts[f], midMonth(f, e.month));
          units[s][f] += milli;
          flow[f][s] += parts[f];
          bought[f].cents += parts[f];
          bought[f].milli += milli;
        }
      }
      history.push({ date: e.date, fund: 'sp500', type: 'Contributions', ...bought.sp500, order: 0 });
      history.push({ date: e.date, fund: 'tech', type: 'Contributions', ...bought.tech, order: 1 });
      monthFlow[e.month] = (monthFlow[e.month] || 0) + bySource.employee + bySource.employer;
    } else if (e.kind === 'interest') {
      const held = units.employee.mm + units.employer.mm;
      const toEmployee = Math.round((MM_INTEREST * units.employee.mm) / held);
      const share = { employee: toEmployee, employer: MM_INTEREST - toEmployee };
      let milli = 0;
      for (const s of SOURCES) { const u = buy(share[s], 100); units[s].mm += u; milli += u; }
      flow.mm.dividends += MM_INTEREST;
      history.push({ date: e.date, fund: 'mm', type: 'Dividend', cents: MM_INTEREST, milli, order: 0 });
    } else if (e.kind === 'exchange') {
      const legs = { tdf: { cents: 0, milli: 0 }, mm: { cents: 0, milli: 0 }, sp500: { cents: 0, milli: 0 }, tech: { cents: 0, milli: 0 } };
      for (const s of SOURCES) {
        const out = { tdf: value(units[s].tdf, EXCHANGE_PRICE.tdf), mm: value(units[s].mm, EXCHANGE_PRICE.mm) };
        legs.tdf.cents -= out.tdf; legs.tdf.milli -= units[s].tdf;
        legs.mm.cents -= out.mm; legs.mm.milli -= units[s].mm;
        units[s].tdf = 0;
        units[s].mm = 0;
        const parts = split8020(out.tdf + out.mm);
        for (const f of ['sp500', 'tech']) {
          const milli = buy(parts[f], EXCHANGE_PRICE[f]);
          units[s][f] += milli;
          legs[f].cents += parts[f];
          legs[f].milli += milli;
        }
      }
      for (const f of Object.keys(legs)) flow[f].exchanges += legs[f].cents;
      history.push({ date: e.date, fund: 'tdf', type: 'Realized Gain/Loss', cents: -legs.tdf.cents - TDF_COST, milli: 0, order: 0 });
      history.push({ date: e.date, fund: 'tdf', type: 'Exchanges', ...legs.tdf, order: 1 });
      history.push({ date: e.date, fund: 'mm', type: 'Exchanges', ...legs.mm, order: 2 });
      history.push({ date: e.date, fund: 'sp500', type: 'Exchanges', ...legs.sp500, order: 3 });
      history.push({ date: e.date, fund: 'tech', type: 'Exchanges', ...legs.tech, order: 4 });
    } else {
      const dps = e.fund === 'sp500' ? SP500_DIVIDEND[e.year] : TECH_DIVIDEND;
      let cents = 0;
      let milli = 0;
      for (const s of SOURCES) {
        const cash = Math.round((units[s][e.fund] * dps) / 1000);
        const u = buy(cash, priceOn(e.fund, e.month));
        units[s][e.fund] += u;
        cents += cash;
        milli += u;
      }
      flow[e.fund].dividends += cents;
      history.push({ date: e.date, fund: e.fund, type: 'Dividend', cents, milli, order: e.fund === 'sp500' ? 0 : 1 });
    }
    const following = events[n + 1];
    if (!following || following.month !== e.month) monthValue[e.month] = valueAt(e.month);
  }

  const closing = total();
  const funds = FUNDS.map((f) => {
    const priceBegin = f.key === 'mm' ? 100 : f.key === 'tdf' ? TDF_PRICE.start : priceOn(f.key, MONTHS[0]);
    const priceEnd = f.key === 'mm' ? 100 : f.key === 'tdf' ? TDF_PRICE.end : priceOn(f.key, MONTHS[MONTHS.length - 1]);
    const begin = value(opening[f.key], priceBegin);
    const end = value(closing[f.key], priceEnd);
    const fl = flow[f.key];
    return {
      ...f, sharesBegin: opening[f.key], sharesEnd: closing[f.key], priceBegin, priceEnd, begin, end,
      yourContributions: fl.employee, employerContributions: fl.employer, exchanges: fl.exchanges,
      dividends: fl.dividends, change: end - begin - fl.employee - fl.employer - fl.exchanges,
    };
  });
  const sum = (k) => funds.reduce((s, x) => s + x[k], 0);
  const t = {
    begin: sum('begin'), end: sum('end'), yourContributions: sum('yourContributions'),
    employerContributions: sum('employerContributions'), exchanges: sum('exchanges'),
    dividends: sum('dividends'), change: sum('change'),
  };
  if (t.exchanges !== 0) throw new Error('exchanges must net to zero');

  // Each source's share of every fund, the rounding remainder to the employer, so the two
  // sources add up to the account exactly.
  const balance = { employee: 0, employer: 0 };
  for (const f of funds) {
    const mine = value(units.employee[f.key], f.priceEnd);
    balance.employee += mine;
    balance.employer += f.end - mine;
  }
  const employerVested = Math.round((balance.employer * EMPLOYER_VESTED_PERCENT) / 100);

  // Time-weighted: each month's Modified Dietz return, contributions weighted mid-month.
  let growth = 1;
  for (let k = 1; k < MONTHS.length; k++) {
    const v0 = monthValue[MONTHS[k - 1]];
    const v1 = monthValue[MONTHS[k]];
    const cf = monthFlow[MONTHS[k]] || 0;
    growth *= 1 + (v1 - v0 - cf) / (v0 + cf / 2);
  }

  const sources = [
    { label: 'Employee Deferral', period: flow.sp500.employee + flow.tech.employee, vestedPercent: 100,
      balance: balance.employee, vestedBalance: balance.employee },
    { label: 'Employer Match', period: flow.sp500.employer + flow.tech.employer, vestedPercent: EMPLOYER_VESTED_PERCENT,
      balance: balance.employer, vestedBalance: employerVested },
  ];
  sources[0].inception = PRE_2024.employee + sources[0].period;
  sources[1].inception = PRE_2024.employer + sources[1].period;

  const statement = {
    logo: 'Northwind',
    plan: 'Northwind Traders, LLC Retirement Savings Plan',
    participant: ['ALEX R SAMPLE', '123 EXAMPLE AVE, APT 12', 'ANYTOWN, CA 00000-'],
    serviceLines: ['Customer Service: (800) 555-0142', 'Fidelity Brokerage Services LLC', '100 Example Street, Anytown, RI 00000'],
    printedAt: '9/19/26, 9:41 AM',
    period: { start: '2024-01-01', end: END, priceDate: START },
    asOf: AS_OF,
    funds: MARKET_VALUE_ORDER.map((k) => funds.find((x) => x.key === k)),
    classOrder: CLASS_ORDER,
    activityOrder: FUNDS.map((f) => f.key),
    total: t,
    vested: balance.employee + employerVested,
    rateOfReturn: `${((growth - 1) * 100).toFixed(1)}%`,
    elections: FUNDS.filter((f) => f.weight).map((f) => ({ investment: f.history, percent: f.weight })),
    sources,
  };
  return { statement, history };
}

// --- the history download --------------------------------------------------

const group3 = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const signed = (n, places) => {
  const unit = 10 ** places;
  const a = Math.abs(n);
  return `${n < 0 ? '-' : ''}${group3(String(Math.floor(a / unit)))}.${String(a % unit).padStart(places, '0')}`;
};
const mdy = (d) => { const [y, m, day] = d.split('-'); return `${m}/${day}/${y}`; };

// The shape of fidelity-401k.csv: a blank line, the plan's name with its unquoted comma and
// trailing padding, the date range padded with empty cells, two blank lines, the header,
// then the rows newest first with quoted, comma-grouped amounts and units. LF throughout.
function historyCsv(history, period) {
  const rows = [...history].sort((a, b) => b.date.localeCompare(a.date) || a.order - b.order);
  const lines = [
    '',
    'Plan name:,NORTHWIND TRADERS, LLC        ',
    `Date Range,${mdy(period.start)} - ${mdy(period.end)},,,,`,
    '',
    '',
    'Date,Investment,Transaction Type,Amount,Shares/Unit',
    ...rows.map((r) => `${mdy(r.date)},${byKey[r.fund].history},${r.type},"${signed(r.cents, 2)}","${signed(r.milli, 3)}"`),
  ];
  return `${lines.join('\n')}\n`;
}

// --- what the statement prints, for a test to hold a reader against ----------

const dollars = (cents) => cents / 100;
const shareCount = (milli) => milli / 1000;
function statementFigures(st, sha256) {
  return {
    generator: 'scripts/fixtures/fidelity-401k-2024.js',
    pdf: `${NAME}.pdf`,
    pdf_sha256: sha256,
    history: `${NAME}.csv`,
    plan: st.plan,
    period: { start: st.period.start, end: st.period.end },
    as_of: st.asOf,
    account_summary: {
      beginning_balance: dollars(st.total.begin),
      your_contributions: dollars(st.total.yourContributions),
      employer_contributions: dollars(st.total.employerContributions),
      change_in_market_value: dollars(st.total.change),
      ending_balance: dollars(st.total.end),
      vested_balance: dollars(st.vested),
      dividends_and_interest: dollars(st.total.dividends),
    },
    personal_rate_of_return: st.rateOfReturn,
    market_value: st.funds.map((f) => ({
      investment: f.name, history_name: f.history, asset_class: f.cls,
      shares_begin: shareCount(f.sharesBegin), shares_end: shareCount(f.sharesEnd),
      price_begin: dollars(f.priceBegin), price_end: dollars(f.priceEnd),
      value_begin: dollars(f.begin), value_end: dollars(f.end),
    })),
    account_activity: st.activityOrder.map((k) => st.funds.find((f) => f.key === k)).map((f) => ({
      investment: f.name,
      beginning_balance: dollars(f.begin),
      your_contributions: dollars(f.yourContributions),
      employer_contributions: dollars(f.employerContributions),
      exchanges: dollars(f.exchanges),
      change_in_market_value: dollars(f.change),
      ending_balance: dollars(f.end),
      dividends_and_interest: dollars(f.dividends),
    })),
    contribution_summary: st.sources.map((s) => ({
      source: s.label, period_to_date: dollars(s.period), inception_to_date: dollars(s.inception),
      vested_percent: s.vestedPercent, total_account_balance: dollars(s.balance),
      total_vested_balance: dollars(s.vestedBalance),
    })),
    elections: st.elections,
    blended_allocation: st.funds.filter((f) => f.mix).map((f) => ({ investment: f.name, ...f.mix })),
  };
}

async function main() {
  const { statement, history } = build();
  fs.writeFileSync(path.join(OUT, `${NAME}.csv`), historyCsv(history, statement.period));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-fixture-'));
  try {
    const html = path.join(work, 'statement.html');
    fs.writeFileSync(html, statementHtml(statement));
    const pdf = path.join(OUT, `${NAME}.pdf`);
    await printToPdf({ html, out: pdf, header: printHeader(statement), footer: printFooter(), scale: 0.665 });
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(pdf)).digest('hex');
    fs.writeFileSync(path.join(OUT, `${NAME}.json`), `${JSON.stringify(statementFigures(statement, sha256), null, 2)}\n`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const t = statement.total;
  console.log(`${NAME}: ${history.length} history rows; ending balance ${dollars(t.end).toFixed(2)}, ` +
    `change in market value ${dollars(t.change).toFixed(2)}, rate of return ${statement.rateOfReturn}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
