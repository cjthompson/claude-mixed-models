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
  'GPT-5.6 Luna':  { family: 'gpt',     tier: 0 },
  'GPT-5.6 Sol':   { family: 'gpt',     tier: 2 },
  'GPT-5.6 Terra': { family: 'gpt',     tier: 1 },
  'GPT-6 Astra':   { family: 'gpt',     tier: 3 },
  'GPT-6-Luna':    { family: 'gpt',     tier: 0 },
  'GPT-6,1-Terra': { family: 'gpt',     tier: 1 },
  'GPT-6-Sol':     { family: 'gpt',     tier: 2 },
  'GPT-6.1-Sol':   { family: 'gpt',     tier: 2 },
  'Haiku 4.5':     { family: 'claude',  tier: 0 },
  'Haiku 5.5':     { family: 'claude',  tier: 0 },
  'MiniMax M2.7':  { family: 'minimax', tier: 0 },
  'MiniMax-M3':    { family: 'minimax', tier: 1 },
  'Opus 5':        { family: 'claude',  tier: 2 },
  'Opus 5.5':      { family: 'claude',  tier: 2 },
  'Opus':          { family: 'claude',  tier: 2 },
  'Sonnet 4.6':    { family: 'claude',  tier: 1 },
  'Sonnet 5':      { family: 'claude',  tier: 1 },
  'Sonnet 5.5':    { family: 'claude',  tier: 1 },
};

function colorFor(model) {
  const info = MODEL_TIERS[model];
  if (!info) return sessionColor(model); // session IDs / unknown → hash palette
  const h = SCHEME_HUES[info.family][info.tier];
  return `hsl(${h} ${TIER_SATURATION[info.tier]}% ${TIER_LIGHTNESS[info.tier]}%)`;
}

// Color a rollup/aggregated row by its real_model when one was captured,
// falling back to the alias. Used for the top-models / effort tables so
// every alias redirected to the same real model renders in the same
// color (e.g. 'haiku' and 'minimax' aliases both landing on MiniMax-M3
// share one swatch).
function colorForRow(row) {
  const real = row._real ?? (row.real_model ? canonicalModel(row.real_model) : null);
  return colorFor(real ?? canonicalModel(row.model ?? row._alias ?? ''));
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
//
// Lookup is case-insensitive: the router logs `real_model: 'MiniMax-M3'`
// while the routes.config.json alias is `'minimax-m3'`. Without lowercasing,
// those would canonicalize to different display names — and the
// "Haiku 4.5 (→ MiniMax-M3)" row would gain a spurious arrow because
// `'MiniMax-M3'` and `'MiniMax-M3'` (alias-side) didn't both hit the
// same MODEL_ALIASES entry.
const MODEL_ALIASES = {
  // Fable (top tier)
  'fable':                       'Fable',
  'claude-fable':                'Fable',
  // Sonnet 4.6 variants
  'claude-sonnet-4-6':           'Sonnet 4.6',
  'claude-sonnet-4-6[1m]':       'Sonnet 4.6',
  'claude-sonnet-5':             'Sonnet 5',
  'claude-sonnet-5-5':           'Sonnet 5.5',
  'sonnet[1m]':                  'Sonnet 5.5',
  'sonnet':                      'Sonnet 5.5',
  // Haiku 4.5 variants
  'claude-haiku-4-5':            'Haiku 4.5',
  'claude-haiku-4-5-20251001':   'Haiku 4.5',
  'claude-haiku-5-5':            'Haiku 5.5',
  'haiku':                       'Haiku 5.5',
  // Opus variants
  'claude-opus':                 'Opus 5.5',
  'claude-opus-4-7':             'Opus 4.7',
  'claude-opus-4-8':             'Opus 4.8',
  'claude-opus-5':               'Opus 5',
  'claude-opus-5-5':             'Opus 5.5',
  'opus':                        'Opus 5,5',
  // GPT / Codex variants
  'gpt-6-luna':                  'GPT-6 Luna',
  'gpt-6-sol':                   'GPT-6 Sol',
  'gpt-6.1-luna':                'GPT-6.1 Luna',
  'gpt-6.1-terra':               'GPT-6.1 Terra',
  'gpt-6.1-sol':                 'GPT-6.1 Sol',
  'gpt-5.6-luna':                'GPT-5.6 Luna',
  'gpt-5.6-terra':               'GPT-5.6 Terra',
  'gpt-5.6-sol':                 'GPT-5.6 Sol',
  'gpt-6-astra':                 'GPT-6 Astra',
  // MiniMax variants — bare `minimax` is the current M3 build. Both
  // the alias side (`minimax-m3`) and the router-captured real_model
  // (`MiniMax-M3`) need to canonicalize identically.
  'minimax':                     'MiniMax-M3',
  'minimax[1m]':                 'MiniMax-M3',
  'minimax-m3':                  'MiniMax-M3',
  'minimax-m2.7':                'MiniMax M2.7',
  // Upstream real-model spellings (the names the upstream returns to
  // the router) — same canonical form as their alias-side counterparts
  // so a redirected request doesn't render with a spurious arrow just
  // because the spelling differs in case or punctuation.
  'minimax-m2-7':                'MiniMax M2.7',
  'minimax-m3-20251001':         'MiniMax-M3',
};

function canonicalModel(name) {
  if (name == null || name === '') return null;
  const aliased = MODEL_ALIASES[name.toLowerCase()];
  return aliased ?? name;
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

// Like aggregateByCanonical but also threads `real_model` through the
// grouping so a row whose alias canonicalizes to one name and whose
// real_model canonicalizes to a different name renders as
// "Alias (→ Real)" instead of collapsing them silently. Same numeric
// aggregation otherwise — used for the top-models / cache-rate / etc
// tables.
function aggregateWithRealModel(rows, numericKeys) {
  const order = [];
  const acc = {};
  for (const r of rows) {
    const alias = canonicalModel(r.model);
    const real = r.real_model ? canonicalModel(r.real_model) : null;
    const label = (real && real !== alias) ? `${alias} (→ ${real})` : alias;
    if (!acc[label]) {
      acc[label] = { model: label, _alias: alias, _real: real };
      for (const k of numericKeys) acc[label][k] = 0;
      order.push(label);
    }
    for (const k of numericKeys) acc[label][k] += r[k] ?? 0;
  }
  return order.map((k) => acc[k]);
}

// Sum requests/tokens by canonical real_model across all aliases that
// were redirected to it. Used for the "Total X served" summary line so
// the viewer can see how much of each upstream model actually ran,
// regardless of how many aliases routed to it.
function totalsByRealModel(rows, numericKeys) {
  const acc = {};
  const order = [];
  for (const r of rows) {
    // NULL real_model → "alias served by its own real model" — count
    // that bucket under the canonical alias itself.
    const real = r.real_model ? canonicalModel(r.real_model) : canonicalModel(r.model);
    if (!acc[real]) {
      acc[real] = { model: real };
      for (const k of numericKeys) acc[real][k] = 0;
      order.push(real);
    }
    for (const k of numericKeys) acc[real][k] += r[k] ?? 0;
  }
  return order.map((k) => acc[k]).sort((a, b) => (b.requests ?? 0) - (a.requests ?? 0));
}

function aggregateTokensByModelEffort(rows) {
  const grouped = new Map();
  for (const row of rows ?? []) {
    const alias = canonicalModel(row.model);
    const real = row.real_model ? canonicalModel(row.real_model) : null;
    const label = (real && real !== alias) ? `${alias} (→ ${real})` : alias;
    const effort = typeof row.effort === 'string' && row.effort ? row.effort : 'unspecified';
    const key = JSON.stringify([label, effort]);
    let item = grouped.get(key);
    if (!item) {
      item = { model: label, effort, requests: 0, tokens: 0, _alias: alias, _real: real };
      grouped.set(key, item);
    }
    item.requests += Number(row.requests ?? 0);
    item.tokens += Number(row.tokens ?? 0);
  }
  return [...grouped.values()].sort((a, b) =>
    b.tokens - a.tokens || a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort),
  );
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
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
  // Tokens per bucket — each stack key is an (alias, real_model) tuple
  // (see viewer-clock.js::normalizeDashboard). Compute the display label
  // from the tuple so redirected aliases render as "Alias (→ Real)"
  // stacks separate from direct calls to the same upstream model. Color
  // by canonical real_model so all M3 traffic shares one swatch.
  document.querySelector('.card--wide h2').textContent = data.tokenChart.title;
  const tokenLabels = data.tokenChart.labels;
  const tokenBuckets = data.tokenChart.buckets;
  const tokenBucketByLabel = new Map(tokenBuckets.map((bucket) => [bucket.label, bucket]));
  const seenStackLabels = new Map();   // stackKey → display label
  const stackKeyInfo = new Map();      // stackKey → { alias, real } for coloring
  for (const bucket of tokenBuckets) {
    for (const stackKey of Object.keys(bucket.models ?? {})) {
      if (seenStackLabels.has(stackKey)) continue;
      const info = bucket.modelInfo?.[stackKey] ?? {};
      const alias = canonicalModel(info.model ?? stackKey);
      const real = info.real_model ? canonicalModel(info.real_model) : null;
      const label = (real && real !== alias) ? `${alias} (→ ${real})` : alias;
      seenStackLabels.set(stackKey, label);
      stackKeyInfo.set(stackKey, { alias, real });
    }
  }
  const stackKeys = [...seenStackLabels.keys()];
  const sortedStackKeys = [...stackKeys].sort((a, b) => seenStackLabels.get(a).localeCompare(seenStackLabels.get(b)));
  renderStackedBar('chart-tokens', tokenLabels, sortedStackKeys,
    (label, stackKey) => Number(tokenBucketByLabel.get(label)?.models?.[stackKey] ?? 0),
    (stackKey) => seenStackLabels.get(stackKey) ?? stackKey,
    (stackKey) => {
      // Color stacks by canonical real_model so all traffic to the same
      // upstream model shares one swatch regardless of which alias the
      // caller used. Use the map built above so stackKeys absent from
      // the first bucket still get their canonical name.
      const { real, alias } = stackKeyInfo.get(stackKey) ?? {};
      return colorFor(real ?? alias);
    }
  );

  // Requests by hour-of-day: server returns per-bucket UTC counts; we
  // group them by *browser-local* hour-of-day so the chart reflects the
  // viewer's timezone rather than the server's.
  renderBars('chart-hours', data.requestHourChart.labels, data.requestHourChart.values);

  // Cache hit rate — combine cache_read / context_tokens across all rows
  // that share the same display label. You can't merge ratios by
  // averaging (a row with 99/100 cache and a row with 0/1 don't average
  // to 99/101), so we sum the counts and recompute the rate per label.
  const cacheAcc = new Map();
  for (const r of data.cacheHitRateByModel ?? []) {
    const alias = canonicalModel(r.model);
    const real = r.real_model ? canonicalModel(r.real_model) : null;
    const label = (real && real !== alias) ? `${alias} (→ ${real})` : alias;
    const prev = cacheAcc.get(label) ?? { model: label, cache_read: 0, context_tokens: 0, _real: real };
    prev.cache_read    += Number(r.cache_read ?? 0);
    prev.context_tokens += Number(r.context_tokens ?? 0);
    cacheAcc.set(label, prev);
  }
  const cacheRows = [...cacheAcc.values()].map((r) => ({
    model: r.model,
    hitRate: r.context_tokens > 0 ? r.cache_read / r.context_tokens : 0,
    _real: r._real,
  }));
  renderBars('chart-cache', cacheRows.map((r) => r.model),
    cacheRows.map((r) => Math.round(r.hitRate * 100)),
    cacheRows.map((r) => colorForRow(r)));

  // Top models — keep alias rows separate when the alias canonicalizes to
  // a different name than real_model ("Haiku 4.5 (→ MiniMax-M3)" stays
  // distinct from "MiniMax-M3" served via the bare `minimax` alias), but
  // collapse them when canonical(alias) === canonical(real_model). The
  // swatch colors by real_model so all M3 traffic reads as one color
  // regardless of which alias the caller used.
  const topModels = aggregateWithRealModel(data.topModels ?? [],
    ['requests', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'thinking', 'errors']);
  // Summary line uses the dedicated totalsByRealModel query — its GROUP BY
  // is on real_model alone (no LIMIT, no alias), so the totals reflect
  // every upstream model that served in the window, not just the top-5.
  const realModelTotals = (data.totalsByRealModel ?? []).map((r) => ({
    model: r.real_model ? canonicalModel(r.real_model) : 'Direct',
    requests: Number(r.requests ?? 0),
  }));
  const realModelSummary = realModelTotals.length > 0
    ? `<tr class="real-model-summary"><td colspan="6"><strong>Total served per real model</strong>: ${
        realModelTotals.map((r) => `${escapeHtml(r.model)} ${abbrev(r.requests)} reqs`).join(' · ')
      }</td></tr>`
    : '';
  document.querySelector('#table-models tbody').innerHTML = topModels.map((r) => `
    <tr>
      <td><span class="session-swatch" style="background:${colorForRow(r)}"></span>${escapeHtml(r.model)}</td>
      <td>${abbrev(r.requests)}</td>
      <td>${abbrev(r.input_tokens + (r.cache_read ?? 0) + (r.cache_write ?? 0))}</td>
      <td>${abbrev(r.output_tokens)}</td>
      <td>${abbrev(r.thinking ?? 0)}</td>
      <td>${r.errors}</td>
    </tr>
  `).join('') + realModelSummary;

  // The API keeps the raw effort string so provider-specific values such as
  // Claude's `xhigh` and Codex's `max` remain distinct in the breakdown.
  const effortTable = document.querySelector('#table-model-effort tbody');
  if (effortTable) {
    const rows = aggregateTokensByModelEffort(data.tokensByModelEffort);
    effortTable.innerHTML = rows.map((r) => `
    <tr>
      <td><span class="session-swatch" style="background:${colorForRow(r)}"></span>${escapeHtml(r.model)}</td>
      <td>${escapeHtml(r.effort === 'unspecified' ? 'Unspecified' : r.effort)}</td>
      <td>${abbrev(r.requests)}</td>
      <td>${abbrev(r.tokens)}</td>
    </tr>
  `).join('') || '<tr><td colspan="4">none</td></tr>';
  }

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

function renderStackedBar(canvasId, labels, series, valueFor, labelFor = (s) => s, colorForSeries = colorFor) {
  const datasets = series.map((key) => ({
    label: labelFor(key),
    data: labels.map((d) => valueFor(d, key)),
    backgroundColor: colorForSeries(key),
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
model = "gpt-6-luna"
model_reasoning_effort = "xhigh"
setInterval(refresh, 10_000);
