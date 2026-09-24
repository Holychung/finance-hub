'use strict';

// NetBenefits' "Statement Details" page, as markup, for the invented account built in
// fidelity-401k-2024.js — the sections, their order, the wording of every heading and of
// the plan's standing notices, and the way Chrome prints it. Every name, number, date and
// address is made up.
//
// The logo, the phone glyph and the allocation chart are pictures on the page, so they are
// drawn on canvas or as SVG paths: they must not add words to the PDF's text layer.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const group3 = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const money = (cents) => {
  const a = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}$${group3(String(Math.floor(a / 100)))}.${String(a % 100).padStart(2, '0')}`;
};
const shares = (milli) => `${group3(String(Math.floor(milli / 1000)))}.${String(milli % 1000).padStart(3, '0')}`;
const mdy = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };

// Printed below the Market Value table. [[…]] marks the words the page links.
const NOTICES = [
  'Remember that a dividend payment to fund shareholders reduces the share price of the fund, so a decrease in the share price for the statement period does not necessarily reflect lower fund performance.',
  '*You have invested a portion of your account in Blended Funds. Blended Funds generally invest in a mixture of stocks, bonds and short-term investments, blending long-term growth from stocks with income from dividends and interest. Please refer to the [[Additional Fund Information]] section to see how your blended funds are allocated across the three asset classes.',
  'Please refer to NetBenefits and other Plan information, such as your SPD, for a description of your right to direct investments under the Plan. For information on any plan restrictions on those rights, please contact your benefits office.',
  'To help achieve long-term retirement security, you should give careful consideration to the benefits of a well-balanced and diversified investment portfolio. Spreading your assets among different types of investments can help you achieve a favorable rate of return, while minimizing your overall risk of losing money. This is because market or other economic conditions that cause one category of assets, or one particular security, to perform very well often cause another asset category, or another particular security, to perform poorly. If you invest more than 20% of your retirement savings in any one company or industry, your savings may not be properly diversified. Although diversification is not a guarantee against loss, it is an effective strategy to help you manage investment risk.',
  'In deciding how to invest your retirement savings, you should take into account all of your assets, including any retirement savings outside of the Plan. No single approach is right for everyone because, among other factors, individuals have different financial goals, different time horizons for meeting their goals, and different tolerances for risk. It is also important to periodically review your investment portfolio, your investment objectives, and the investment options under the Plan to help ensure that your retirement savings will meet your retirement goals. Visit the Dept of Labor website www.dol.gov/agencies/ebsa/laws-and-regulations/laws/pension-protection-act/investing-and-diversification for information on individual investing and diversification.',
  'Please check your account information frequently and promptly review correspondence, account statements, and confirmation as they are available to you. Contact Fidelity immediately if you see or suspect unauthorized activity, errors, discrepancies, or if you have not received account documents or information.',
  'Some of the administrative services performed for the Plan were underwritten from the total operating expenses of the Plan’s investment options.',
];
const linked = (text) => esc(text).replace(/\[\[(.+?)\]\]/g, '<a>$1</a>');

// Chrome's own header and footer, as a person's "Save as PDF" prints them: the time it was
// printed and the page title above, the page's address and the page count below. Supplied
// rather than left to Chrome, which would print this machine's clock and a file:// path.
const PRINT_FONT = "font-family:'Times New Roman',Times,serif;font-size:8pt;color:#111;";
const PAGE_URL = 'https://workplaceservices.fidelity.com/mybenefits/savings2/sod/soddetail';
const printHeader = (st) => `<div style="${PRINT_FONT}width:100%;margin:0 0.28in;display:flex">
  <span style="flex:1.2">${esc(st.printedAt)}</span>
  <span style="flex:1.6;text-align:center">Fidelity NetBenefits - Statement Details</span>
  <span style="flex:0.8"></span></div>`;
const printFooter = () => `<div style="${PRINT_FONT}width:100%;margin:0 0.28in;display:flex;justify-content:space-between">
  <span>${PAGE_URL}</span>
  <span><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`;

function statementHtml(st) {
  const period = `Statement Period: ${mdy(st.period.start)} to ${mdy(st.period.end)}`;
  const asOf = `As of ${mdy(st.asOf)}`;
  const t = st.total;
  const sectionHead = (title, right, cls = '') =>
    `<div class="sec ${cls}"><h2>${esc(title)}</h2><div class="period">${esc(right)}</div></div>`;

  // Market Value of Your Account: by asset class, each class's totals on its own row.
  const mvRows = [];
  for (const cls of st.classOrder) {
    const members = st.funds.filter((x) => x.cls === cls);
    if (!members.length) continue;
    const sum = (k) => members.reduce((s, x) => s + x[k], 0);
    mvRows.push(`<tr class="grp"><td colspan="5">${esc(cls)}</td><td class="n big">${money(sum('begin'))}</td><td class="n big">${money(sum('end'))}</td></tr>`);
    let sub = null;
    for (const x of members) {
      if (x.sub && x.sub !== sub) { sub = x.sub; mvRows.push(`<tr class="sub"><td colspan="7">${esc(sub)}</td></tr>`); }
      mvRows.push(`<tr><td class="fund">${esc(x.name)}</td><td class="n">${shares(x.sharesBegin)}</td><td class="n">${shares(x.sharesEnd)}</td>` +
        `<td class="n">${money(x.priceBegin)}</td><td class="n">${money(x.priceEnd)}</td><td class="n">${money(x.begin)}</td><td class="n">${money(x.end)}</td></tr>`);
    }
  }
  mvRows.push(`<tr class="totals"><td colspan="5">Account Totals</td><td class="n">${money(t.begin)}</td><td class="n">${money(t.end)}</td></tr>`);

  // Your Account Activity: four columns to a table, the total last.
  const cols = [...st.activityOrder.map((key) => st.funds.find((x) => x.key === key)).map((x) => ({ label: x.name, v: x })), { label: 'Total', v: t }];
  const activity = [];
  for (let i = 0; i < cols.length; i += 4) {
    const chunk = cols.slice(i, i + 4);
    const row = (label, key, cls) =>
      `<tr class="${cls}"><td class="lbl">${esc(label)}</td>${chunk.map((c) => `<td class="n">${money(c.v[key])}</td>`).join('')}</tr>`;
    activity.push(`<table class="act"><thead><tr><th class="lbl">Activity</th>${chunk.map((c) => `<th class="n">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>` +
      row('Beginning Balance', 'begin', 'b') +
      row('Your Contributions', 'yourContributions', 'in') +
      row('Employer Contributions', 'employerContributions', 'in') +
      row('Exchanges', 'exchanges', 'in') +
      row('Change in Market Value', 'change', 'in') +
      row('Ending Balance', 'end', 'b') +
      row('Dividends & Interest', 'dividends', 'in') +
      '</tbody></table>');
  }

  const stockEnd = st.funds.filter((x) => x.cls === 'Stock').reduce((s, x) => s + x.end, 0);
  const legend = `${((stockEnd / t.end) * 100).toFixed(2)}% Stock: ${money(stockEnd)}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Fidelity NetBenefits - Statement Details</title>
<style>
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; }
  .frame { border: 1px solid #dcdcdc; border-top: 0; padding-bottom: 150px; }
  .col { width: 650px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0; padding: 26px 0 20px; }
  .logo { display: block; margin: 0 0 6px 18px; }
  .head { display: flex; justify-content: space-between; }
  .head .l, .head .r { width: 50%; }
  .plan { font-weight: bold; font-size: 13px; line-height: 16px; width: 235px; }
  .title { font-weight: bold; font-size: 13px; margin-top: 12px; text-align: center; }
  .addr { font-size: 12px; line-height: 16px; margin-top: 16px; }
  .cs { font-size: 11px; line-height: 14px; margin-top: 18px; padding-left: 64px; }
  .cs svg { vertical-align: -1px; margin-right: 2px; }
  .sec { display: flex; justify-content: space-between; align-items: flex-start;
         border-top: 3px solid #555; box-shadow: inset 0 1px 0 #aaa; margin-top: 22px; padding-top: 8px; }
  .sec h2 { font-size: 14px; margin: 0; }
  .sec .period { font-family: Verdana, Geneva, sans-serif; font-size: 12px; margin-top: 7px; }
  .sec.tall .period { margin-top: 3px; }
  .sec.big h2 { font-size: 17px; }
  .sec.big .period { margin-top: 5px; }
  .v { font-family: Verdana, Geneva, sans-serif; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  td.n, th.n { text-align: right; }
  .summary { margin-top: 30px; }
  .summary td { padding: 1px 0; }
  .summary tr.b td { font-weight: bold; padding: 18px 0 8px; }
  .summary tr.first td { padding-top: 0; }
  .summary tr.hd td { font-weight: bold; padding: 20px 0 8px; }
  .rule { border-bottom: 2px solid #ccc; padding-bottom: 6px; }
  .ror h3 { color: #c8481e; font-size: 14px; margin: 28px 0 0 12px; }
  .ror .row { display: flex; font-weight: bold; margin: 22px 0 0 16px; }
  .ror .row span:first-child { width: 376px; }
  .ror p { margin: 16px 8px 0; line-height: 17px; }
  .alloc { display: flex; align-items: center; margin: 26px 0 0 8px; }
  p { line-height: 16px; }
  a { color: #1b3f95; text-decoration: underline; }
  .intro { margin: 18px 0 0; }
  .tier { text-align: center; font-weight: bold; margin: 18px 0 8px; }
  .mv th { font-weight: bold; vertical-align: bottom; padding: 0 0 4px 6px; line-height: 14px; border-bottom: 1px solid #555; }
  .mv th.inv { text-align: left; font-style: italic; padding-left: 0; }
  .mv td { padding: 7px 0 7px 6px; }
  .mv td.fund { padding-left: 0; width: 90px; line-height: 14px; }
  .mv tr.grp td { font-weight: bold; padding-left: 0; }
  .mv tr.grp td.big, .mv tr.totals td { font-family: Verdana, Geneva, sans-serif; font-size: 13px; font-weight: bold; }
  .mv tr.sub td { color: #777; padding: 12px 0 0; }
  .mv tr.totals td { padding: 10px 0 12px; }
  .mv-end { border-top: 3px solid #555; box-shadow: inset 0 1px 0 #aaa; height: 4px; }
  .notes p { font-family: Verdana, Geneva, sans-serif; font-size: 12px; line-height: 17px; margin: 14px 0 0; }
  .elect { margin: 36px 0 0; font-weight: bold; }
  .elect-src { color: #aaa; font-weight: bold; margin: 6px 0 0 4px; }
  .el { width: 420px; margin-left: 8px; }
  .el td { padding: 6px 0; }
  .el td.p { text-align: center; }
  .el .h td { font-weight: bold; vertical-align: top; }
  .el .cat td { font-weight: bold; padding-top: 16px; }
  .el .sub td { color: #777; font-size: 10px; padding-top: 10px; }
  .el .tot td { font-weight: bold; padding-top: 26px; }
  .cs-tbl { margin-top: 26px; }
  .cs-tbl th, .cs-tbl td { font-family: Verdana, Geneva, sans-serif; font-size: 12px; }
  .cs-tbl th { font-weight: bold; vertical-align: bottom; padding-bottom: 12px; border-bottom: 1px solid #ccc; line-height: 15px; }
  .cs-tbl th.l { text-align: left; }
  .cs-tbl td { padding: 12px 0 6px; }
  .cs-tbl td.l { font-weight: bold; line-height: 15px; width: 100px; }
  .cs-tbl tr:last-child td { padding-bottom: 18px; }
  .act { margin-top: 26px; }
  .act th, .act td { font-family: Verdana, Geneva, sans-serif; font-size: 12px; }
  .act th { font-weight: bold; vertical-align: bottom; border-bottom: 1px solid #333; padding: 0 0 2px 10px; line-height: 14px; }
  .act th.lbl { text-align: left; padding-left: 0; width: 180px; }
  .act td { padding: 3px 0 2px 10px; }
  .act td.lbl { padding-left: 0; }
  .act tr.b td { font-weight: bold; }
  .act tr.in td.lbl { padding-left: 6px; }
  .act tbody tr:first-child td { padding-top: 12px; }
  .afi { margin-top: 18px; }
  .afi th { font-style: italic; font-weight: bold; border-bottom: 1px solid #555; padding: 0 0 4px; }
  .afi th.l, .afi td.l { text-align: left; }
  .afi th.c, .afi td.c { text-align: center; }
  .afi td { padding: 3px 0 0; font-size: 12px; }
  .fine { font-size: 10px; line-height: 12px; margin: 18px 0 0; }
</style></head>
<body><div class="frame"><div class="col">
<h1>Statement Details</h1>
<canvas class="logo" id="logo" width="360" height="72" style="width:180px;height:36px"></canvas>
<div class="head">
  <div class="l">
    <div class="plan">${esc(st.plan)}</div>
    <div class="addr">${st.participant.map(esc).join('<br>')}</div>
  </div>
  <div class="r">
    <div class="title">Retirement Savings Statement</div>
    <div class="cs"><svg width="13" height="11" viewBox="0 0 13 11"><path d="M1 3.5c0-1.4 2.6-2.5 5.5-2.5S12 2.1 12 3.5v1.2H9.4V3.6c-.8-.3-1.8-.4-2.9-.4s-2.1.1-2.9.4v1.1H1zM3 5.2h7l1.5 5.3h-10z" fill="#111"/></svg>${st.serviceLines.map(esc).join('<br>')}</div>
  </div>
</div>

${sectionHead('Your Account Summary', period, 'tall')}
<table class="summary v">
  <tr class="b first"><td>Beginning Balance</td><td class="n">${money(t.begin)}</td></tr>
  <tr><td>Your Contributions</td><td class="n">${money(t.yourContributions)}</td></tr>
  <tr><td>Employer Contributions</td><td class="n">${money(t.employerContributions)}</td></tr>
  <tr><td>Change in Market Value</td><td class="n">${money(t.change)}</td></tr>
  <tr class="b"><td>Ending Balance</td><td class="n">${money(t.end)}</td></tr>
  <tr class="hd"><td colspan="2">Additional Information</td></tr>
  <tr><td>Vested Balance</td><td class="n">${money(st.vested)}</td></tr>
  <tr><td class="rule">Dividends &amp; Interest</td><td class="n rule">${money(t.dividends)}</td></tr>
</table>

<div class="ror">
  <h3>Your Personal Rate of Return</h3>
  <div class="row"><span>This Period</span><span>${esc(st.rateOfReturn)}</span></div>
  <p class="v">Your Personal Rate of Return is calculated with a time-weighted formula, widely used by financial analysts to calculate investment earnings. It reflects the results of your investment selections as well as any activity in the plan account(s) shown. There are other Personal Rate of Return formulas used that may yield different results. Remember that past performance is no guarantee of future results.</p>
</div>

${sectionHead('Your Asset Allocation', period)}
<div class="alloc"><canvas id="pie" width="880" height="400" style="width:440px;height:200px"></canvas></div>
<p class="intro" style="margin-top:36px">Your account is allocated among the asset classes specified above as of ${mdy(st.period.end)}. Percentages and totals may not be exact due to rounding.</p>
<p>${linked('The [[Additional Fund Information]] section lists the underlying allocation of your blended funds.')}</p>

${sectionHead('Market Value of Your Account', period)}
<p class="intro">Displayed in this section is the value of your account for the statement period, in both shares and dollars.</p>
<div class="tier">Tier</div>
<table class="mv">
  <thead><tr><th class="inv">Investment</th><th class="n">Shares as of ${mdy(st.period.priceDate)}</th><th class="n">Shares as of ${mdy(st.period.end)}</th>
  <th class="n">Price as of ${mdy(st.period.priceDate)}</th><th class="n">Price as of ${mdy(st.period.end)}</th>
  <th class="n">Market Value as of ${mdy(st.period.priceDate)}</th><th class="n">Market Value as of ${mdy(st.period.end)}</th></tr></thead>
  <tbody>${mvRows.join('\n')}</tbody>
</table>
<div class="mv-end"></div>
<div class="notes">${NOTICES.map((p) => `<p>${linked(p)}</p>`).join('\n')}</div>

${sectionHead('Your Contribution Elections as of', asOf, 'big')}
<p class="intro">This section displays information related to your contributions.</p>
<div class="elect">Your Current Investment Elections as of ${mdy(st.asOf)}</div>
<div class="elect-src v">All Eligible Sources</div>
<table class="el">
  <tr class="h"><td>Investment Option</td><td class="p">Current<br>%</td></tr>
  <tr class="cat"><td colspan="2">Stock Investments</td></tr>
  <tr class="sub"><td colspan="2">LARGE CAP</td></tr>
  ${st.elections.map((x) => `<tr><td>${esc(x.investment)}</td><td class="p">${x.percent}%</td></tr>`).join('\n  ')}
  <tr class="tot"><td>Total</td><td class="p">100%</td></tr>
</table>

${sectionHead('Your Contribution Summary', period)}
<table class="cs-tbl">
  <thead><tr><th class="l">Contributions</th><th class="n">Period to<br>date</th><th class="n">Inception To<br>Date</th><th class="n">Vested<br>Percent</th><th class="n">Total Account<br>Balance</th><th class="n">Total Vested<br>Balance</th></tr></thead>
  <tbody>${st.sources.map((s) => `<tr><td class="l">${esc(s.label).replace(' ', '<br>')}</td><td class="n">${money(s.period)}</td><td class="n">${money(s.inception)}</td><td class="n">${s.vestedPercent}%</td><td class="n">${money(s.balance)}</td><td class="n">${money(s.vestedBalance)}</td></tr>`).join('\n')}</tbody>
</table>

${sectionHead('Your Account Activity', period)}
<p class="intro">Use this section as a summary of transactions that occurred in your account during the statement period.</p>
<p><a>Detailed Transaction History</a></p>
${activity.join('\n')}

${sectionHead('Additional Fund Information', asOf)}
<p class="intro">Use this section to determine the asset allocation of your blended investments.</p>
<table class="afi">
  <thead><tr><th class="l">Blended Investment</th><th class="c">Stocks</th><th class="c">Bonds</th><th class="c">Short-Term/Other</th></tr></thead>
  <tbody>${st.funds.filter((x) => x.mix).map((x) => `<tr><td class="l">${esc(x.name)}</td><td class="c">${x.mix.stocks}%</td><td class="c">${x.mix.bonds}%</td><td class="c">${x.mix.short}%</td></tr>`).join('\n')}</tbody>
</table>
<p class="fine">Blended investments generally invest in more than one asset class. The blended investment asset allocation above reflects the stated neutral mix or, if not available, the asset mix reported by Morningstar, Inc. for mutual funds or by investment managers for non-mutual funds.</p>
</div></div>
<script>
  const logo = document.getElementById('logo').getContext('2d');
  logo.scale(2, 2);
  logo.fillStyle = '#1f6f78';
  logo.beginPath(); logo.moveTo(14, 4); logo.lineTo(24, 18); logo.lineTo(14, 32); logo.lineTo(4, 18); logo.closePath(); logo.fill();
  logo.fillStyle = '#233';
  logo.font = 'bold 22px Georgia, serif';
  logo.fillText(${JSON.stringify(st.logo)}, 32, 26);

  const pie = document.getElementById('pie').getContext('2d');
  pie.scale(2, 2);
  pie.beginPath(); pie.arc(96, 100, 90, 0, Math.PI * 2);
  pie.fillStyle = '#132f91'; pie.fill(); pie.lineWidth = 1; pie.strokeStyle = '#000'; pie.stroke();
  pie.fillStyle = '#132f91'; pie.fillRect(206, 97, 7, 7);
  pie.fillStyle = '#222'; pie.font = '12px Verdana, sans-serif';
  pie.fillText(${JSON.stringify(legend)}, 220, 105);
</script>
</body></html>
`;
}

module.exports = { statementHtml, printHeader, printFooter, money, shares, mdy };
