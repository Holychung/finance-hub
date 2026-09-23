'use strict';

// Hand-built inline SVG — no chart library and no CDN, which is why this is
// sixty lines rather than a dependency: two shapes, drawn from numbers the
// server already computed.
//
// No colour is written here. lineChart emits its gradient stops and its end
// marker bare and `.chart stop` / `.chart circle` supply them; BAR_COLORS
// holds `var(--chart-N)` strings. A hex in this file would be invisible to
// every check style.css makes on itself.

// Round numbers a reader can hold — 1, 2, 2.5 or 5 times a power of ten —
// covering the range in roughly `count` steps. Gridlines at a quarter and a
// half of the height are decoration; a gridline is worth drawing only if you
// can read a number off it.
function niceTicks(min, max, count = 3) {
  const mag = 10 ** Math.floor(Math.log10((max - min) / count));
  const stepFor = (step) => {
    const out = [];
    // Multiply rather than accumulate: adding a float step tens of times
    // drifts enough to print 2.8999999M.
    for (let k = Math.ceil(min / step); k * step <= max; k++) out.push({ value: k * step, step });
    return out;
  };
  // Chosen by how many lines the step actually draws, not by the first step
  // wide enough for the range. The ladder jumps 5 → 10, so "first wide
  // enough" took 100K for a 159K range and drew a single gridline next to a
  // neighbouring chart with three; 50K draws three and is just as round.
  let best = null;
  for (const m of [1, 2, 2.5, 5, 10]) {
    const ticks = stepFor(m * mag);
    if (!ticks.length) continue;
    const cost = Math.abs(ticks.length - count);
    if (!best || cost < best.cost) best = { cost, ticks };
  }
  return best ? best.ticks : [];
}

// The step decides the precision, not the value: a step of 0.2 printed at
// whole numbers gives three gridlines all labelled "1", which is worse than
// no labels because it looks like a bug in the data.
// Every chart on the page needs its own gradient id; see where it is used.
let gradSeq = 0;

const axisLabel = (rawN, step) => {
  // A range that crosses zero lands a tick on it, and that tick arrives as
  // -0, which formats as "-0". `=== 0` is true for both zeroes.
  const n = rawN === 0 ? 0 : rawN;
  const a = Math.abs(n);
  if (a >= 1e6) return `${nf(n / 1e6, 2)}M`;
  if (a >= 1e3) return `${nf(n / 1e3, 1)}K`;
  return nf(n, step >= 1 ? 0 : Math.min(2, Math.ceil(-Math.log10(step))));
};

// The plot is SVG stretched to the box (`preserveAspectRatio="none"`), which
// is what lets it fill any width exactly — but that transform scales the two
// axes differently, so anything inside it that is supposed to look the same in
// both directions comes out wrong. Text was being squashed horizontally, the
// end marker was an ellipse and the strokes were thicker across than down.
//
// So only the two paths live in the SVG, with `non-scaling-stroke` to keep
// their width honest. Gridlines, both axes and the end marker are HTML placed
// over the same box by percentage: crisp at any size, one type scale with the
// rest of the app, and free to carry a value rather than just a position.
// No height option any more: the plot is sized by `.chart-plot` in CSS, like
// every other box in the app, and the one caller was passing the same number
// every time.
// Nothing to draw still takes a chart's room — see `.chart-empty`.
const chartEmpty = (msg) => html`<div class="chart"><div class="chart-plot chart-empty">${empty(msg)}</div></div>`;

function lineChart(series, cur = 'TWD') {
  const pts = series.filter((p) => p.value !== null);
  if (pts.length < 2) return chartEmpty(pts.length ? '資料點還不夠畫走勢（至少要兩個月）' : '無資料');

  const vals = pts.map((p) => p.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  min -= span * 0.12; max += span * 0.12;

  // The viewBox is the plot area itself, so a value maps straight to a
  // fraction of it and HTML can be positioned by the same fraction.
  const frac = (v) => 1 - (v - min) / (max - min);
  const x = (i) => (i / (pts.length - 1)) * 1000;
  const y = (v) => frac(v) * 1000;

  // Path data is numbers only; it carries no user input.
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = `${line}L1000,1000L0,1000Z`;

  const last = pts[pts.length - 1];
  // `top` is the only inline style left in here, and it has to be: it is the
  // datum, not a theme choice.
  const gridlines = niceTicks(min, max).map(({ value, step }) => {
    const top = `${(frac(value) * 100).toFixed(2)}%`;
    return html`<span class="chart-grid" style="top:${top}"></span>
      <span class="chart-y" style="top:${top}">${axisLabel(value, step)}</span>`;
  });

  const at = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i);

  // Everything the hover needs, worked out here where the scale and the
  // currency are known, and carried in one attribute. The alternative — a
  // registry keyed by chart id — would have to be swept every time a view
  // rebuilds, which is constantly.
  const hover = pts.map((p) => ({
    y: +(frac(p.value) * 100).toFixed(2),
    t: `${p.date.slice(0, 7)} · ${money(p.value, cur)}`,
  }));

  // A gradient is referenced by id, and ids are global to the document. The
  // overview draws one chart per currency, so a fixed id meant two elements
  // answering to `nwgrad` and both areas painted from whichever the browser
  // saw first. Identical gradients hid it; the moment two charts differ it
  // would not have been.
  const gradId = `nwgrad-${++gradSeq}`;

  return html`<div class="chart">
    <!-- The whole plot is hidden from assistive tech, not just the SVG: the
         axis labels are HTML, so a reader would otherwise recite "400.0K
         2026-04 2026-06" as loose words between the cards. The table below
         is the readable form of all of it. -->
    <div class="chart-plot" data-points="${JSON.stringify(hover)}" aria-hidden="true">
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none">
        <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-opacity=".22"/>
          <stop offset="100%" stop-opacity="0"/>
        </linearGradient></defs>
        <path class="area" fill="url(#${gradId})" d="${area}"/>
        <path class="line" d="${line}" vector-effect="non-scaling-stroke"/>
      </svg>
      ${gridlines}
      <span class="chart-dot" style="top:${(frac(last.value) * 100).toFixed(2)}%"></span>
      <span class="chart-cursor"><span class="chart-cursor-dot"></span></span>
      <span class="chart-tip"></span>
    </div>
    <div class="chart-x" aria-hidden="true">${at.map((i) => html`<span>${pts[i].date.slice(0, 7)}</span>`)}</div>
    ${seriesTable(pts, cur)}
  </div>`;
}

// The hover reads the chart with a mouse and nothing else does. `role="img"`
// with a summary of the endpoints was the whole keyboard and screen-reader
// story, so the ten months in between could not be reached at all — which is
// most of what the chart is for.
//
// A <details> is the cheapest honest answer: keyboard-reachable with no
// handler of ours, announced as a disclosure, and it carries every figure the
// hover carries. The SVG above it goes aria-hidden so the same numbers are
// not read out twice as a shape and a table.
function seriesTable(pts, cur) {
  return html`<details class="chart-data">
    <summary>以表格檢視 ${pts.length} 個月</summary>
    <div class="table-wrap scroll">
      <table>
        <thead><tr><th>月份</th><th class="num">帳戶淨額</th><th class="num">較上月</th></tr></thead>
        <tbody>${pts.map((p, i) => {
          const change = i === 0 ? null : round2(p.value - pts[i - 1].value);
          return html`<tr>
            <td class="nowrap">${p.date.slice(0, 7)}</td>
            <td class="num ${level(p.value)}">${money(p.value, cur)}</td>
            <td class="num ${change === null ? 'dim' : cls(change)}">
              ${change === null ? '—' : signed(change, cur)}</td>
          </tr>`;
        })}</tbody>
      </table>
    </div>
  </details>`;
}

// A chart with a dozen points and no way to ask what any of them is, is a
// picture of a trend rather than a reading of it. Hovering snaps to the
// nearest month and says the date and the figure.
//
// One delegated listener, wired once from app.js: a view rebuilds its markup
// on every mutation, so a handler bound to a chart would be thrown away with
// the chart. Reading the points back off the element rather than holding them
// here means nothing survives a render that should not.
function wireChartHover() {
  let active = null;
  const leave = () => {
    if (active) active.classList.remove('hovering');
    active = null;
  };

  document.addEventListener('pointermove', (e) => {
    const plot = e.target.closest?.('.chart-plot');
    if (!plot) return leave();
    if (plot !== active) { leave(); active = plot; plot.classList.add('hovering'); }

    const pts = JSON.parse(plot.dataset.points);
    const box = plot.getBoundingClientRect();
    const i = Math.min(pts.length - 1, Math.max(0,
      Math.round(((e.clientX - box.left) / box.width) * (pts.length - 1))));
    const pct = (i / (pts.length - 1)) * 100;

    $('.chart-cursor', plot).style.left = `${pct}%`;
    $('.chart-cursor-dot', plot).style.top = `${pts[i].y}%`;

    const tip = $('.chart-tip', plot);
    tip.textContent = pts[i].t;
    tip.style.left = `${pct}%`;
    tip.style.top = `${pts[i].y}%`;
    // A tooltip centred on the first or last month would hang outside the
    // card, so at the ends it anchors by its own edge instead.
    tip.classList.toggle('at-start', pct < 12);
    tip.classList.toggle('at-end', pct > 88);
  });

  // pointermove alone never fires again once the cursor is off the window.
  document.addEventListener('pointerleave', leave, true);
}

// The asset pole of a diverging scale; liabilities take `--down` below. One
// hue stepped by lightness, not seven cycling hues: the rows are sorted by
// size and each is already labelled with its own name and number, so colour
// carries magnitude, not identity. Brightest first — the ground is dark, so
// bright is what reads as loudest and the largest slice takes --chart-1. A
// light theme would reverse the ramp, not the order. Defined in style.css so
// the palette stays in one place — see CLAUDE.md "Styling".
const BAR_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

function barBreakdown(entries, total, cur = "TWD") {
  if (!entries.length || !total) return empty('無資料');
  // A bar is a share of something, and one entry is not a share of anything:
  // it is always the full width, so it says strictly less than the `100.0%`
  // already printed beside it while being the loudest thing in the card. Keep
  // the row, drop the graphic.
  const solo = entries.length < 2;
  return entries.map(([name, value], i) => {
    // `total` is the sum of magnitudes, so every share is positive and the
    // column adds up to 100%. Printing a liability's share as −3.4% broke that
    // — the reader's own check that the parts make a whole — and said "this is
    // money you owe" a third time, after the red bar and the negative amount
    // beside it. A share of a total is not an amount; only the amount is.
    const share = total ? Math.abs((value / total) * 100) : 0;
    const width = Math.min(100, share).toFixed(1);
    const color = value < 0 ? 'var(--down)' : BAR_COLORS[i % BAR_COLORS.length];
    return html`<div class="bar-row ${solo ? 'solo' : ''}">
      <span class="name">${name}</span>
      ${solo ? '' : html`<span class="bar-track"
        ><span class="bar-fill" style="width:${width}%;background:${color}"></span></span>`}
      <span class="val">${nf(share, 1)}%</span>
      <span class="val ${value < 0 ? 'neg' : 'dim'}">${money(value, cur)}</span>
    </div>`;
  });
}
