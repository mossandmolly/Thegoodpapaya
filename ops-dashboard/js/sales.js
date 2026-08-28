// Good Papaya Ops — Sales dashboard
// Calls the sales-dashboard edge function (service-role aggregation over
// invoice_line_items) and renders weekly veg-vs-fruit trends + society spread.

const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const pct = n => Number(n || 0).toFixed(0) + '%';

function defaultMonth() {
  return todayIST().slice(0, 7);
}

document.getElementById('ctl-month').value = defaultMonth();
document.getElementById('ctl-launch').value = '2026-08-15';

async function loadDashboard() {
  const body = document.getElementById('dashboard-body');
  const status = document.getElementById('ctl-status');
  body.innerHTML = '<div class="state-msg">Loading…</div>';
  status.textContent = '';

  const month = document.getElementById('ctl-month').value || defaultMonth();
  const launch = document.getElementById('ctl-launch').value || '2026-08-15';

  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/sales-dashboard?month=${month}&launch_date=${launch}`,
      { headers: {
          'Authorization': 'Bearer ' + (session?.access_token || SUPABASE_ANON),
          'apikey': SUPABASE_ANON,
      } },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load dashboard');
    render(data);
    status.textContent = 'Updated ' + new Date(data.generatedAt).toLocaleTimeString('en-IN');
  } catch (err) {
    body.innerHTML = `<div class="state-msg">⚠️ ${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function deltaArrow(pre, post, { biggerIsUp = true, suffix = '' } = {}) {
  if (!pre && !post) return '<span class="kpi-arrow flat">–</span>';
  if (!pre) return `<span class="kpi-arrow up">▲ new</span>`;
  const change = ((post - pre) / pre) * 100;
  const dir = change > 0.5 ? 'up' : change < -0.5 ? 'down' : 'flat';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '–';
  return `<span class="kpi-arrow ${dir}">${arrow} ${Math.abs(change).toFixed(0)}%${suffix}</span>`;
}

function render(data) {
  const body = document.getElementById('dashboard-body');
  const { weeks, summary, societies, unmatchedItems, launchDate } = data;

  if (!weeks.length || !data.totalOrders) {
    body.innerHTML = '<div class="state-msg">No invoiced orders found for this month yet.</div>';
    return;
  }

  const unmatchedHtml = unmatchedItems.length
    ? `<div class="unmatched-note">⚠️ ${unmatchedItems.length} item name(s) aren't in the catalog's vegetable/fruit list yet and are excluded from the veg/fruit split below: ${unmatchedItems.map(escapeHtml).join(', ')}. Fix this in Admin → Catalog.</div>`
    : '';

  body.innerHTML = unmatchedHtml + kpiHtml(summary, launchDate) +
    weeklyChartsHtml(weeks) + weeklyTableHtml(weeks) + societyHtml(societies);

  drawRevenueChart(weeks);
  drawVegAdoptionChart(weeks);
}

function kpiHtml(summary, launchDate) {
  const { pre, post } = summary;
  return `
  <div class="kpi-grid">
    <div class="kpi-card">
      <h3>Average order value</h3>
      <div class="kpi-compare"><span class="kpi-val">${inr(post.aov)}</span>${deltaArrow(pre.aov, post.aov)}</div>
      <div class="kpi-prepost"><span>Pre-veg: <b>${inr(pre.aov)}</b></span><span>Post-veg: <b>${inr(post.aov)}</b></span></div>
      <div class="kpi-sub">Post = orders billed on/after ${launchDate}</div>
    </div>
    <div class="kpi-card">
      <h3>Order frequency (orders/day)</h3>
      <div class="kpi-compare"><span class="kpi-val">${post.ordersPerDay}</span>${deltaArrow(pre.ordersPerDay, post.ordersPerDay)}</div>
      <div class="kpi-prepost"><span>Pre-veg: <b>${pre.ordersPerDay}/day</b></span><span>Post-veg: <b>${post.ordersPerDay}/day</b></span></div>
      <div class="kpi-sub">${pre.orders} orders pre vs ${post.orders} orders post (${pre.days}d vs ${post.days}d)</div>
    </div>
    <div class="kpi-card">
      <h3>Orders containing vegetables</h3>
      <div class="kpi-compare"><span class="kpi-val" style="color:var(--veg-dark)">${pct(post.veg.pctOfOrders)}</span><span class="kpi-arrow up">${post.veg.orders} orders</span></div>
      <div class="kpi-prepost"><span>Pre-veg: <b>${pct(pre.veg.pctOfOrders)}</b></span><span>Post-veg: <b>${pct(post.veg.pctOfOrders)}</b></span></div>
      <div class="kpi-sub">Veg revenue post-launch: ${inr(post.veg.revenue)} · veg AOV ${inr(post.veg.aov)}</div>
    </div>
    <div class="kpi-card">
      <h3>Fruit revenue</h3>
      <div class="kpi-compare"><span class="kpi-val" style="color:var(--fruit-dark)">${inr(post.fruit.revenue)}</span>${deltaArrow(pre.fruit.revenue, post.fruit.revenue)}</div>
      <div class="kpi-prepost"><span>Pre-veg: <b>${inr(pre.fruit.revenue)}</b></span><span>Post-veg: <b>${inr(post.fruit.revenue)}</b></span></div>
      <div class="kpi-sub">Fruit orders: ${pre.fruit.orders} pre → ${post.fruit.orders} post</div>
    </div>
  </div>`;
}

function weeklyChartsHtml(weeks) {
  return `
  <div class="section">
    <h2>Vegetable vs fruit revenue, by week</h2>
    <p class="hint">Each week of ${weeks[0].start.slice(0,7)}. If vegetable revenue is rising while fruit revenue holds steady, vegetables are additive; if fruit falls as vegetables rise, customers are substituting.</p>
    <div class="legend"><span><i class="swatch veg"></i>Vegetable revenue</span><span><i class="swatch fruit"></i>Fruit revenue</span></div>
    <div class="chart-wrap" id="chart-revenue"></div>
  </div>
  <div class="section">
    <h2>% of orders that include a vegetable</h2>
    <p class="hint">Share of that week's orders with at least one vegetable line item.</p>
    <div class="chart-wrap" id="chart-veg-adoption"></div>
  </div>`;
}

// ── SVG chart helpers ────────────────────────────────────────────────────────

const CHART_W = 900, CHART_H = 240, PAD_L = 46, PAD_R = 16, PAD_T = 16, PAD_B = 34;

function niceMax(v) {
  if (v <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function drawRevenueChart(weeks) {
  const el = document.getElementById('chart-revenue');
  if (!el) return;
  const plotW = CHART_W - PAD_L - PAD_R, plotH = CHART_H - PAD_T - PAD_B;
  const maxVal = niceMax(Math.max(...weeks.map(w => Math.max(w.veg.revenue, w.fruit.revenue)), 1));
  const groupW = plotW / weeks.length;
  const barW = Math.min(34, groupW * 0.32);

  let bars = '', gridLines = '', xLabels = '';
  for (let g = 0; g <= 4; g++) {
    const y = PAD_T + plotH - (g / 4) * plotH;
    gridLines += `<line class="grid-line" x1="${PAD_L}" x2="${CHART_W - PAD_R}" y1="${y}" y2="${y}"/>`;
    gridLines += `<text class="axis-label" x="${PAD_L - 8}" y="${y + 3}" text-anchor="end">${inr(maxVal * g / 4)}</text>`;
  }

  weeks.forEach((w, i) => {
    const cx = PAD_L + groupW * i + groupW / 2;
    const vegH = (w.veg.revenue / maxVal) * plotH;
    const fruitH = (w.fruit.revenue / maxVal) * plotH;
    const vegX = cx - barW - 2, fruitX = cx + 2;
    bars += `<rect x="${vegX}" y="${PAD_T + plotH - vegH}" width="${barW}" height="${vegH}" rx="3" fill="#1baf7a"/>`;
    bars += `<rect x="${fruitX}" y="${PAD_T + plotH - fruitH}" width="${barW}" height="${fruitH}" rx="3" fill="#e34948"/>`;
    if (w.veg.revenue > 0) bars += `<text class="bar-label" x="${vegX + barW/2}" y="${PAD_T + plotH - vegH - 5}" text-anchor="middle">${Math.round(w.veg.revenue/1000)}k</text>`;
    if (w.fruit.revenue > 0) bars += `<text class="bar-label" x="${fruitX + barW/2}" y="${PAD_T + plotH - fruitH - 5}" text-anchor="middle">${Math.round(w.fruit.revenue/1000)}k</text>`;
    xLabels += `<text class="axis-label" x="${cx}" y="${CHART_H - PAD_B + 18}" text-anchor="middle">${w.label.split(' (')[0]}${w.period==='post' ? ' 🥦' : ''}</text>`;
  });

  el.innerHTML = `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" style="width:100%;min-width:520px;height:auto">${gridLines}${bars}${xLabels}</svg>`;
}

function drawVegAdoptionChart(weeks) {
  const el = document.getElementById('chart-veg-adoption');
  if (!el) return;
  const plotW = CHART_W - PAD_L - PAD_R, plotH = CHART_H - PAD_T - PAD_B;
  const maxVal = 100;
  const stepX = plotW / Math.max(weeks.length - 1, 1);

  let gridLines = '', xLabels = '', points = [], dots = '', labels = '';
  for (let g = 0; g <= 4; g++) {
    const y = PAD_T + plotH - (g / 4) * plotH;
    gridLines += `<line class="grid-line" x1="${PAD_L}" x2="${CHART_W - PAD_R}" y1="${y}" y2="${y}"/>`;
    gridLines += `<text class="axis-label" x="${PAD_L - 8}" y="${y + 3}" text-anchor="end">${g * 25}%</text>`;
  }

  weeks.forEach((w, i) => {
    const x = PAD_L + stepX * i;
    const y = PAD_T + plotH - (w.veg.pctOfOrders / maxVal) * plotH;
    points.push(`${x},${y}`);
    dots += `<circle cx="${x}" cy="${y}" r="4.5" fill="#1baf7a"/>`;
    labels += `<text class="bar-label" x="${x}" y="${y - 10}" text-anchor="middle" font-weight="600">${pct(w.veg.pctOfOrders)}</text>`;
    xLabels += `<text class="axis-label" x="${x}" y="${CHART_H - PAD_B + 18}" text-anchor="middle">${w.label.split(' (')[0]}</text>`;
  });

  const line = `<polyline points="${points.join(' ')}" fill="none" stroke="#1baf7a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;

  el.innerHTML = `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" style="width:100%;min-width:520px;height:auto">${gridLines}${line}${dots}${labels}${xLabels}</svg>`;
}

function weeklyTableHtml(weeks) {
  const rows = weeks.map(w => `
    <tr class="period-${w.period}">
      <td>${escapeHtml(w.label)}</td>
      <td><span class="period-tag tag-${w.period}">${w.period}</span></td>
      <td>${w.orders}</td>
      <td>${inr(w.aov)}</td>
      <td>${w.veg.orders} (${pct(w.veg.pctOfOrders)})</td>
      <td>${inr(w.veg.revenue)}</td>
      <td>${inr(w.veg.aov)}</td>
      <td>${w.fruit.orders} (${pct(w.fruit.pctOfOrders)})</td>
      <td>${inr(w.fruit.revenue)}</td>
    </tr>`).join('');

  return `
  <div class="section">
    <h2>Week-by-week detail</h2>
    <p class="hint">Frequency = orders billed that week. AOV = revenue ÷ orders.</p>
    <div class="data-table-wrap">
      <table class="sales-table">
        <thead><tr>
          <th>Week</th><th>Period</th><th>Orders (frequency)</th><th>AOV</th>
          <th>Orders w/ veg</th><th>Veg revenue</th><th>Veg AOV</th>
          <th>Orders w/ fruit</th><th>Fruit revenue</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function societyHtml(societies) {
  const totalCustomers = new Set();
  const rows = societies.map(s => `
    <tr>
      <td style="font-weight:500">${escapeHtml(s.society)}</td>
      <td>${s.customers}</td>
      <td>${s.orders}</td>
      <td>${inr(s.revenue)}</td>
      <td>${inr(s.aov)}</td>
      <td style="min-width:140px">
        <span class="veg-pct-bar">
          <span class="veg-pct-track"><span class="veg-pct-fill" style="width:${s.vegPctOfOrders}%"></span></span>
          <span>${pct(s.vegPctOfOrders)}</span>
        </span>
      </td>
      <td>${s.vegOrders}</td>
    </tr>`).join('');

  return `
  <div class="section">
    <h2>Customer spread across societies</h2>
    <p class="hint">${societies.length} societies with billed orders this month, sorted by revenue.</p>
    <div class="data-table-wrap">
      <table class="sales-table">
        <thead><tr>
          <th>Society</th><th>Customers</th><th>Orders</th><th>Revenue</th><th>AOV</th>
          <th>% orders w/ veg</th><th>Veg orders</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

loadDashboard();
