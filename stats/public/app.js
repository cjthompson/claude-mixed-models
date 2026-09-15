// --- Color scheme: Earth ---
// Terracotta (claude-*) / Slate (gpt-*) / Moss (minimax*), with per-family
// hue drift across 4 performance tiers (0 = dim → 3 = brightest).
const SCHEME_HUES = {
  claude:  [15, 18, 21, 24],
  gpt:     [224, 220, 216, 212],
  minimax: [126, 130, 134, 138],
};
const TIER_LIGHTNESS  = [25, 40, 60, 80];
const TIER_SATURATION = [45, 60, 78, 90];

// Performance tier per canonical model. Tier 3 = brightest (Fable, Astra),
// tier 2 = Opus/Sol, tier 1 = Sonnet/Terra/MiniMax-M3, tier 0 = Haiku/Luna/M2.7.
const MODEL_TIERS = {
  'Fable':         { family: 'claude',  tier: 3 },
  'GPT-6 Astra':   { family: 'gpt',     tier: 3 },
  'Opus':          { family: 'claude',  tier: 2 },
  'Opus 5':        { family: 'claude',  tier: 2 },
  'GPT-5.6 Sol':   { family: 'gpt',     tier: 2 },
  'Sonnet 4.6':    { family: 'claude',  tier: 1 },
  'Sonnet 5':      { family: 'claude',  tier: 1 },
  'GPT-5.6 Terra': { family: 'gpt',     tier: 1 },
  'MiniMax-M3':    { family: 'minimax', tier: 1 },
  'Haiku 4.5':     { family: 'claude',  tier: 0 },
  'GPT-5.6 Luna':  { family: 'gpt',     tier: 0 },
  'MiniMax M2.7':  { family: 'minimax', tier: 0 },
};

function colorFor(model) {
  const info = MODEL_TIERS[model];
  if (!info) return sessionColor(model); // session IDs / unknown → hash palette
  const h = SCHEME_HUES[info.family][info.tier];
  return `hsl(${h} ${TIER_SATURATION[info.tier]}% ${TIER_LIGHTNESS[info.tier]}%)`;
}

// Sessions get a stable palette independent of model prefix family.
function hashKey(s) {
  let h = 5381;
  const str = String(s ?? '');
  const len = Math.min(str.length, 8);
  for (let i = 0; i < len; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}
const PALETTE = ['#a479e2', '#4a86e8', '#16a766', '#fad165', '#ffad47', '#fb4c2f', '#999999', '#f691b3', '#43d692', '#ff7537', '#7bd3f7', '#b9e4d0'];
function sessionColor(s) { return PALETTE[hashKey(s) % PALETTE.length]; }

// Map raw model names (as stored in the DB) to canonical display names.
// Multiple raw names that map to the same canonical will have their stats
// summed client-side (see aggregateByCanonical below).
const MODEL_ALIASES = {
  // Fable (top tier)
  'fable':                       'Fable',
  'claude-fable':                'Fable',
  // Sonnet 4.6 variants
  'claude-sonnet-4-6':           'Sonnet 4.6',
  'claude-sonnet-4-6[1m]':       'Sonnet 4.6',
  'sonnet[1m]':                  'Sonnet 4.6',
  'sonnet':                      'Sonnet 4.6',
  // Haiku 4.5 variants
  'claude-haiku-4-5':            'Haiku 4.5',
  'claude-haiku-4-5-20251001':   'Haiku 4.5',
  'haiku':                       'Haiku 4.5',
  // Opus variants
  'claude-opus':                 'Opus',
  'claude-opus-4-7':             'Opus',
  'claude-opus-4-8':             'Opus',
  'claude-opus-5':               'Opus 5',
  'opus':                        'Opus',
  // Sonnet 5
  'claude-sonnet-5':             'Sonnet 5',
  // GPT / Codex variants
  'gpt-5.6-luna':                'GPT-5.6 Luna',
  'gpt-5.6-terra':               'GPT-5.6 Terra',
  'gpt-5.6-sol':                 'GPT-5.6 Sol',
  'gpt-6-astra':                 'GPT-6 Astra',
  // MiniMax variants — bare `minimax` is the current M3 build
  'minimax':                     'MiniMax-M3',
  'minimax-m3':                  'MiniMax-M3',
  'minimax-m2.7':                'MiniMax M2.7',
};

function canonicalModel(name) {
  return MODEL_ALIASES[name] ?? name;
}

function aggregateByCanonical(rows, numericKeys) {
  const order = [];
  const acc = {};
  for (const r of rows) {
    const key = canonicalModel(r.model);
    if (!acc[key]) { acc[key] = { model: key }; for (const k of numericKeys) acc[key][k] = 0; order.push(key); }
    for (const k of numericKeys) acc[key][k] += r[k] ?? 0;
  }
  return order.map((k) => acc[k]);
}

const charts = {};
let lastEtag = null;

function abbrev(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (Math.round(n / 100) / 10) + 'k';
  return (Math.round(n / 100_000) / 10) + 'M';
}

async function refresh() {
  const range = document.getElementById('range').value;
  let data;
  try {
    const headers = lastEtag ? { 'If-None-Match': lastEtag } : {};
    const res = await fetch(`/api/stats?range=${range}`, { headers });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastEtag = res.headers.get('etag');
    data = ViewerClock.fromBrowser().normalizeDashboard(await res.json());
  } catch (err) {
    console.error('fetch failed', err);
    return;
  }

  // Today's totals
  const t = data.rangeTotals ?? {};
  const RANGE_LABELS = { '1h': '1 hour', '5h': '5 hours', '24h': '24 hours', '7d': '7 days', '30d': '30 days', 'all': 'All time' };
  document.querySelector('#card-totals h2').textContent = RANGE_LABELS[range] ?? range;
  // Show the reasoning line only when the day had any — most days on a
  // Haiku/Sonnet-only workload will be 0, and "Reasoning 0" would just
  // be visual noise.
  const thinkingLine = t.thinking > 0
    ? `<div><span class="label">Reasoning</span><span class="value">${abbrev(t.thinking)}</span></div>`
    : '';
  document.getElementById('totals').innerHTML = `
    <div><span class="label">Requests</span><span class="value">${abbrev(t.requests)}</span></div>
    <div><span class="label">Context</span><span class="value">${abbrev(t.input_tokens + (t.cache_read ?? 0) + (t.cache_write ?? 0))}</span></div>
    <div><span class="label">Output</span><span class="value">${abbrev(t.output_tokens)}</span></div>
    ${thinkingLine}
  `;

  // Tokens per bucket (stacked by model). Title + label format depend on
  // the bucket grain: 5m for sub-hour ranges, hour for 24h, day otherwise.
  document.querySelector('.card--wide h2').textContent = data.tokenChart.title;
  const tokenLabels = data.tokenChart.labels;
  const tokenBuckets = data.tokenChart.buckets;
  const tokenBucketByLabel = new Map(tokenBuckets.map((bucket) => [bucket.label, bucket]));
  const models = [...new Set(tokenBuckets.flatMap((b) => Object.keys(b.models ?? {}).map(canonicalModel)))].sort();
  renderStackedBar('chart-tokens', tokenLabels, models, (label, model) => {
    const bucket = tokenBucketByLabel.get(label);
    return Object.entries(bucket?.models ?? {}).filter(([raw]) => canonicalModel(raw) === model)
      .reduce((sum, [, tokens]) => sum + tokens, 0);
  });

  // Requests by hour-of-day: server returns per-bucket UTC counts; we
  // group them by *browser-local* hour-of-day so the chart reflects the
  // viewer's timezone rather than the server's.
  renderBars('chart-hours', data.requestHourChart.labels, data.requestHourChart.values);

  // Cache hit rate (percent)
  const cacheRows = [];
  const seenCache = new Set();
  for (const r of data.cacheHitRateByModel ?? []) {
    const cm = canonicalModel(r.model);
    if (!seenCache.has(cm)) { seenCache.add(cm); cacheRows.push({ model: cm, hitRate: r.hitRate }); }
  }
  renderBars('chart-cache', cacheRows.map((r) => r.model),
    cacheRows.map((r) => Math.round(r.hitRate * 100)),
    cacheRows.map((r) => colorFor(r.model)));

  // Top models
  const topModels = aggregateByCanonical(data.topModels ?? [],
    ['requests', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'thinking', 'errors']);
  document.querySelector('#table-models tbody').innerHTML = topModels.map((r) => `
    <tr>
      <td><span class="session-swatch" style="background:${colorFor(r.model)}"></span>${r.model}</td>
      <td>${abbrev(r.requests)}</td>
      <td>${abbrev(r.input_tokens + (r.cache_read ?? 0) + (r.cache_write ?? 0))}</td>
      <td>${abbrev(r.output_tokens)}</td>
      <td>${abbrev(r.thinking ?? 0)}</td>
      <td>${r.errors}</td>
    </tr>
  `).join('');

  // Top sessions
  document.querySelector('#table-sessions tbody').innerHTML = (data.topSessions ?? []).map((r) => `
    <tr>
      <td><span class="session-swatch" style="background:${colorFor(r.session_id)}"></span>${r.session_id?.slice(0, 8) ?? '—'}</td>
      <td>${r.requests}</td>
      <td>${abbrev(r.tokens)}</td>
    </tr>
  `).join('');

  // Errors
  document.querySelector('#table-errors tbody').innerHTML =
    (data.errorsByStatus ?? []).map((r) => `<tr><td>${r.status}</td><td>${r.count}</td></tr>`).join('')
    || '<tr><td colspan="2">none</td></tr>';
}

function renderBars(canvasId, labels, values, colors = '#4a86e8') {
  if (charts[canvasId]) {
    const c = charts[canvasId];
    c.data.labels = labels;
    c.data.datasets[0].data = values;
    c.data.datasets[0].backgroundColor = colors;
    c.update('none');
    return;
  }
  const ctx = document.getElementById(canvasId).getContext('2d');
  charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });
}

function renderStackedBar(canvasId, labels, series, valueFor) {
  const datasets = series.map((name) => ({
    label: name,
    data: labels.map((d) => valueFor(d, name)),
    backgroundColor: colorFor(name),
    stack: 'tokens',
  }));

  if (charts[canvasId]) {
    const c = charts[canvasId];
    // Preserve which models the user has toggled off in the legend
    const hidden = new Set(
      c.data.datasets.filter((_, i) => !c.isDatasetVisible(i)).map((ds) => ds.label)
    );
    c.data.labels = labels;
    c.data.datasets = datasets;
    datasets.forEach((ds, i) => {
      c.getDatasetMeta(i).hidden = hidden.has(ds.label) ? true : null;
    });
    c.update('none');
    return;
  }

  const ctx = document.getElementById(canvasId).getContext('2d');
  charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      plugins: { legend: { display: true } },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
    },
  });
}

document.getElementById('range').addEventListener('change', () => {
  localStorage.setItem('stats-range', document.getElementById('range').value);
  refresh();
});
const VALID_RANGES = ['1h', '5h', '24h', '7d', '30d', 'all'];
const savedRange = localStorage.getItem('stats-range');
if (savedRange && VALID_RANGES.includes(savedRange)) {
  document.getElementById('range').value = savedRange;
}
refresh();
setInterval(refresh, 10_000);
