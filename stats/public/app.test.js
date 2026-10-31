import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const clockSource = await readFile(new URL('./viewer-clock.js', import.meta.url), 'utf8');

function element(value = '') {
  return {
    value,
    textContent: '',
    innerHTML: '',
    addEventListener() {},
    getContext() { return {}; },
  };
}

function appHarness() {
  const charts = [];
  const elements = new Map([
    ['range', element('7d')],
    ['totals', element()],
    ['chart-tokens', element()],
    ['chart-hours', element()],
    ['chart-cache', element()],
  ]);
  const modelRows = element();
  const selectors = new Map([
    ['#card-totals h2', element()],
    ['.card--wide h2', element()],
    ['#table-models tbody', modelRows],
    ['#table-sessions tbody', element()],
    ['#table-errors tbody', element()],
  ]);
  const row = (model) => ({
    model,
    requests: 1,
    input_tokens: 1,
    output_tokens: 1,
    cache_read: 0,
    cache_write: 0,
    thinking: 0,
    errors: 0,
  });
  const payload = {
    range: '7d',
    tokensByBucket: [
      { bucket: '2026-09-12T00:00:00.000Z', model: 'claude-opus-5-5', tokens: 2 },
      { bucket: '2026-09-12T00:00:00.000Z', model: 'claude-sonnet-5-5', tokens: 3 },
    ],
    requestsByHourOfDay: [],
    cacheHitRateByModel: [],
    topModels: [
      row('claude-opus-5-5'),
      row('claude-sonnet-5-5'),
      row('gpt-6.1-luna'),
      row('gpt-6.1-terra'),
      row('gpt-6.1-sol'),
      row('gpt-6-astra'),
    ],
    topSessions: [],
    errorsByStatus: [],
    rangeTotals: { requests: 6, input_tokens: 6, output_tokens: 6, cache_read: 0, cache_write: 0, thinking: 0 },
  };
  const context = {
    document: {
      getElementById(id) { return elements.get(id); },
      querySelector(selector) { return selectors.get(selector); },
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      json: async () => payload,
    }),
    Chart: class { constructor(_ctx, config) { this.data = config.data; this.options = config.options; this.config = config; charts.push(this); } update() {} isDatasetVisible() { return true; } getDatasetMeta() { return {}; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    setInterval() {},
    console,
  };
  vm.runInNewContext(clockSource, context, { filename: 'stats/public/viewer-clock.js' });
  return { context, modelRows, charts };
}

test('renders human-readable labels for the supported model aliases', async () => {
  const { context, modelRows } = appHarness();
  vm.runInNewContext(appSource, context, { filename: 'stats/public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  for (const label of ['Opus 5.5', 'Sonnet 5.5', 'GPT-6.1 Luna', 'GPT-6.1 Terra', 'GPT-6.1 Sol', 'GPT-6 Astra']) {
    assert.ok(modelRows.innerHTML.includes(`>${label}<`), `missing rendered label: ${label}`);
  }
});

test('renders normalized token buckets for multiple models', async () => {
  const { context, charts } = appHarness();
  vm.runInNewContext(appSource, context, { filename: 'stats/public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tokenChart = charts.find((chart) => chart.data.datasets.some((d) => d.label === 'Opus 5.5'));
  assert.ok(tokenChart);
  assert.deepEqual([...tokenChart.data.datasets.map((d) => d.label)].sort(), ['Opus 5.5', 'Sonnet 5.5']);
  assert.deepEqual([...tokenChart.data.datasets.map((d) => d.data[0])], [2, 3]);
});

// When an alias routes to a different real model (e.g. `claude-haiku-4-5`
// → `MiniMax-M3`), the top-models row should render as "Haiku 4.5
// (→ MiniMax-M3)" rather than collapsing to either name alone. The
// fixture also has a `minimax` alias that resolves to MiniMax-M3 with no
// redirect (alias and real canonicalize identically) — that row should
// render as just "MiniMax-M3" so the table doesn't show redundant arrows.
test('renders redirect arrow when alias and real_model canonicalize differently', async () => {
  const { context, modelRows } = appHarness();
  const payload = context.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    json: async () => ({
      range: '7d',
      tokensByBucket: [],
      requestsByHourOfDay: [],
      cacheHitRateByModel: [],
      topModels: [
        // The user's scenario: claude-haiku-4-5 alias redirects to MiniMax-M3.
        { model: 'claude-haiku-4-5', real_model: 'MiniMax-M3', requests: 1000,
          input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
          thinking: 0, errors: 0 },
        // Same real model, but the alias already canonicalizes to it
        // — no redirect arrow needed.
        { model: 'minimax', real_model: 'MiniMax-M3', requests: 234,
          input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
          thinking: 0, errors: 0 },
        // Truly independent: alias and real differ.
        { model: 'claude-opus', real_model: 'claude-opus', requests: 50,
          input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
          thinking: 0, errors: 0 },
      ],
      topSessions: [],
      errorsByStatus: [],
      rangeTotals: { requests: 1284, input_tokens: 3, output_tokens: 3, cache_read: 0, cache_write: 0, thinking: 0 },
    }),
  });
  vm.runInNewContext(appSource, context, { filename: 'stats/public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Redirect row: alias canonicalizes to "Haiku 4.5", real to "MiniMax-M3"
  // — different names, so the label includes the arrow.
  assert.match(modelRows.innerHTML, />Haiku 4\.5 \(→ MiniMax-M3\)</);
  // Same canonical name on both sides: no arrow.
  assert.match(modelRows.innerHTML, />MiniMax-M3</);
  assert.doesNotMatch(modelRows.innerHTML, />MiniMax-M3 \(→ /);
  // No redirect: alias canonicalizes to itself.
  assert.match(modelRows.innerHTML, />Opus 5.5</);
});

// Tokens-by-model-effort rows sort by model (known models by family, then
// tier, then name; unknown models last), then by effort low → max with
// unknown efforts last. Token counts are deliberately inverted so a
// token-descending sort would fail.
test('sorts tokens-by-model-effort rows by model then effort', async () => {
  const { context } = appHarness();
  const effortBody = element();
  const rows = [
    { model: 'mystery-model', effort: 'max', requests: 1, tokens: 100 },
    { model: 'claude-opus-5-5', effort: 'max', requests: 1, tokens: 900000 },
    { model: 'claude-haiku-5-5', effort: 'xhigh', requests: 1, tokens: 10 },
    { model: 'claude-sonnet-5-5', effort: 'high', requests: 1, tokens: 300 },
    { model: 'mystery-model', effort: 'weird', requests: 1, tokens: 600000 },
    { model: 'claude-opus-5-5', effort: 'unspecified', requests: 1, tokens: 700000 },
    { model: 'claude-haiku-5-5', effort: 'medium', requests: 1, tokens: 20 },
    { model: 'claude-sonnet-5-5', effort: 'max', requests: 1, tokens: 200000 },
    { model: 'claude-opus-5-5', effort: 'high', requests: 1, tokens: 400 },
    { model: 'mystery-model', effort: '', requests: 1, tokens: 800000 },
    { model: 'claude-haiku-5-5', effort: 'max', requests: 1, tokens: 4 },
    { model: 'claude-sonnet-5-5', effort: 'low', requests: 1, tokens: 2 },
    { model: 'claude-opus-5-5', effort: 'medium', requests: 1, tokens: 3 },
    { model: 'claude-haiku-5-5', effort: 'low', requests: 1, tokens: 1 },
    { model: 'claude-sonnet-5-5', effort: 'xhigh', requests: 1, tokens: 5 },
    { model: 'claude-opus-5-5', effort: 'xhigh', requests: 1, tokens: 6 },
    { model: 'claude-sonnet-5-5', effort: 'medium', requests: 1, tokens: 7 },
    { model: 'claude-opus-5-5', effort: 'low', requests: 1, tokens: 8 },
    { model: 'claude-haiku-5-5', effort: 'high', requests: 1, tokens: 9 },
  ];
  const baseFetch = context.fetch;
  context.fetch = async (...args) => {
    const res = await baseFetch(...args);
    const base = await res.json();
    return { ...res, json: async () => ({ ...base, tokensByModelEffort: rows }) };
  };
  const querySelector = context.document.querySelector;
  context.document.querySelector = (selector) =>
    selector === '#table-model-effort tbody' ? effortBody : querySelector(selector);

  vm.runInNewContext(appSource, context, { filename: 'stats/public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const rendered = [...effortBody.innerHTML.matchAll(/<td><span[^>]*><\/span>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g)]
    .map((m) => [m[1], m[2]]);
  const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  const expected = [
    ...['Haiku 5.5', 'Sonnet 5.5'].flatMap((model) => claudeEfforts.map((effort) => [model, effort])),
    ...claudeEfforts.map((effort) => ['Opus 5.5', effort]),
    ['Opus 5.5', 'Unspecified'],
    ['mystery-model', 'max'],
    ['mystery-model', 'Unspecified'],
    ['mystery-model', 'weird'],
  ];
  assert.deepEqual(rendered, expected);
});

async function renderModelEffort(rows) {   // rows may be undefined
  const { context } = appHarness();
  const effortBody = element();
  const baseFetch = context.fetch;
  context.fetch = async (...a) => {
    const res = await baseFetch(...a);
    const base = await res.json();
    return { ...res, json: async () => ({ ...base, tokensByModelEffort: rows }) };
  };
  const qs = context.document.querySelector;
  context.document.querySelector = (s) => (s === '#table-model-effort tbody' ? effortBody : qs(s));
  vm.runInNewContext(appSource, context, { filename: 'stats/public/app.js' });
  await new Promise((r) => setTimeout(r, 0));
  return effortBody.innerHTML;
}

const ROW_RE = /<tr>\s*<td><span class="session-swatch" style="background:([^"]*)"><\/span>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/g;
const parseRows = (html) => [...html.matchAll(ROW_RE)].map((m) => ({ color: m[1], model: m[2], effort: m[3], requests: m[4], tokens: m[5] }));

test('renders requests and tokens cells abbreviated in tokens-by-model-effort rows', async () => {
  const html = await renderModelEffort([
    { model: 'claude-opus-5-5', effort: 'high', requests: 1234, tokens: 1234567 },
    { model: 'claude-haiku-4-5', real_model: 'MiniMax-M3', effort: 'low', requests: 999, tokens: 1000 },
    { model: 'mystery-model', effort: 'max', requests: 0, tokens: 12345 },
    { model: 'claude-sonnet-5-5', effort: 'medium', requests: null, tokens: null },
  ]);
  const rows = parseRows(html);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => [r.model, r.effort, r.requests, r.tokens]), [
    ['Sonnet 5.5', 'medium', '0', '0'],
    ['Opus 5.5', 'high', '1.2k', '1.2M'],
    ['Haiku 4.5 (→ MiniMax-M3)', 'low', '999', '1k'],
    ['mystery-model', 'max', '0', '12.3k'],
  ]);
});

test('colors tokens-by-model-effort swatches for known, redirected, and unknown models', async () => {
  const html = await renderModelEffort([
    { model: 'claude-opus-5-5', effort: 'high', requests: 1, tokens: 1 },
    { model: 'claude-sonnet-5-5', effort: 'medium', requests: 1, tokens: 1 },
    { model: 'claude-haiku-4-5', real_model: 'MiniMax-M3', effort: 'low', requests: 1, tokens: 1 },
    { model: 'minimax-m3', effort: 'low', requests: 1, tokens: 1 },
    { model: 'mystery-model', effort: 'max', requests: 1, tokens: 1 },
    { model: 'claude-sonnet-5-5', real_model: 'mystery-real', effort: 'low', requests: 1, tokens: 1 },
  ]);
  const rows = parseRows(html);
  assert.equal(rows.length, 6);
  const colorOf = (label) => {
    const row = rows.find((r) => r.model === label);
    assert.ok(row, `missing row: ${label}`);
    return row.color;
  };
  assert.equal(colorOf('Opus 5.5'), 'hsl(21 78% 60%)');
  assert.equal(colorOf('Sonnet 5.5'), 'hsl(18 60% 40%)');
  // Redirected row takes the real model's color, not Haiku's own.
  const redirected = colorOf('Haiku 4.5 (→ MiniMax-M3)');
  assert.equal(redirected, 'hsl(130 60% 40%)');
  assert.notEqual(redirected, 'hsl(15 45% 25%)');
  assert.equal(colorOf('MiniMax-M3'), redirected);
  assert.match(colorOf('mystery-model'), /^#[0-9a-f]{6}$/);
  const mysteryReal = colorOf('Sonnet 5.5 (→ mystery-real)');
  assert.match(mysteryReal, /^#[0-9a-f]{6}$/);
  assert.notEqual(mysteryReal, 'hsl(18 60% 40%)');
});

test('renders the empty state when tokensByModelEffort is empty', async () => {
  for (const rows of [[], undefined]) {
    const html = await renderModelEffort(rows);
    assert.equal(html, '<tr><td colspan="4">none</td></tr>');
    assert.equal(parseRows(html).length, 0);
  }
});

test('sorts redirected tokens-by-model-effort rows by real model, not alias', async () => {
  const html = await renderModelEffort([
    { model: 'claude-opus-5-5', effort: 'low', requests: 1, tokens: 1 },
    { model: 'claude-haiku-4-5', real_model: 'MiniMax-M3', effort: 'high', requests: 1, tokens: 1 },
    { model: 'claude-haiku-4-5', real_model: 'MiniMax-M3', effort: 'low', requests: 1, tokens: 1 },
    { model: 'minimax-m2.7', effort: 'low', requests: 1, tokens: 1 },
    { model: 'minimax-m3', effort: 'low', requests: 1, tokens: 1 },
    { model: 'gpt-5.6-sol', effort: 'low', requests: 1, tokens: 1 },
    { model: 'claude-sonnet-5-5', real_model: 'mystery-real', effort: 'low', requests: 1, tokens: 1 },
    { model: 'mystery-model', effort: 'low', requests: 1, tokens: 1 },
  ]);
  const rows = parseRows(html);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map((r) => [r.model, r.effort]), [
    ['Opus 5.5', 'low'],
    ['GPT-5.6 Sol', 'low'],
    ['MiniMax M2.7', 'low'],
    ['Haiku 4.5 (→ MiniMax-M3)', 'low'],
    ['Haiku 4.5 (→ MiniMax-M3)', 'high'],
    ['MiniMax-M3', 'low'],
    ['mystery-model', 'low'],
    ['Sonnet 5.5 (→ mystery-real)', 'low'],
  ]);
});

test('orders GPT and MiniMax families by MODEL_TIERS family then tier', async () => {
  const html = await renderModelEffort([
    { model: 'minimax-m3', effort: 'low', requests: 1, tokens: 1 },
    { model: 'gpt-6-astra', effort: 'low', requests: 1, tokens: 1 },
    { model: 'minimax-m2.7', effort: 'low', requests: 1, tokens: 1 },
    { model: 'gpt-5.6-sol', effort: 'low', requests: 1, tokens: 1 },
    { model: 'gpt-5.6-luna', effort: 'low', requests: 1, tokens: 1 },
    { model: 'claude-opus-5-5', effort: 'low', requests: 1, tokens: 1 },
    { model: 'gpt-5.6-terra', effort: 'low', requests: 1, tokens: 1 },
    { model: 'fable', effort: 'low', requests: 1, tokens: 1 },
  ]);
  const rows = parseRows(html);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map((r) => [r.model, r.color]), [
    ['Opus 5.5', 'hsl(21 78% 60%)'],
    ['Fable', 'hsl(24 90% 80%)'],
    ['GPT-5.6 Luna', 'hsl(224 45% 25%)'],
    ['GPT-5.6 Terra', 'hsl(220 60% 40%)'],
    ['GPT-5.6 Sol', 'hsl(216 78% 60%)'],
    ['GPT-6 Astra', 'hsl(212 90% 80%)'],
    ['MiniMax M2.7', 'hsl(126 45% 25%)'],
    ['MiniMax-M3', 'hsl(130 60% 40%)'],
  ]);
});

test('merges raw model strings that canonicalize to the same label', async () => {
  const html = await renderModelEffort([
    { model: 'claude-sonnet-5-5', effort: 'high', requests: 2, tokens: 100 },
    { model: 'sonnet', effort: 'high', requests: 3, tokens: 200 },
    { model: 'SONNET[1M]', effort: 'high', requests: 5, tokens: 300 },
    { model: 'sonnet', effort: 'low', requests: 7, tokens: 400 },
    { model: 'claude-haiku-4-5', effort: 'low', requests: 1, tokens: 10 },
    { model: 'claude-haiku-4-5-20251001', effort: 'low', requests: 2, tokens: 20 },
    { model: 'minimax', real_model: 'minimax-m3-20251001', effort: 'low', requests: 4, tokens: 1000 },
    { model: 'minimax-m3', effort: 'low', requests: 6, tokens: 2000 },
    { model: 'MiniMax-M3', real_model: 'MiniMax-M3', effort: 'low', requests: 8, tokens: 3000 },
  ]);
  const rows = parseRows(html);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => [r.model, r.effort, r.requests, r.tokens]), [
    ['Haiku 4.5', 'low', '3', '30'],
    ['Sonnet 5.5', 'low', '7', '400'],
    ['Sonnet 5.5', 'high', '10', '600'],
    ['MiniMax-M3', 'low', '18', '6k'],
  ]);
});

test('sorts unresolved GPT names after known ones with hash colors', async () => {
  // MODEL_TIERS keys ('GPT-6-Sol', 'GPT-6,1-Terra', ...) don't match canonical GPT-6 names, so these render as unknown.
  const html = await renderModelEffort([
    { model: 'gpt-6.1-sol', effort: 'low', requests: 1, tokens: 1 },
    { model: 'gpt-6-luna', effort: 'low', requests: 1, tokens: 1 },
    { model: 'gpt-6.1-terra', effort: 'low', requests: 1, tokens: 1 },
    { model: 'gpt-6-sol', effort: 'low', requests: 1, tokens: 1 },
    { model: 'gpt-6.1-luna', effort: 'low', requests: 1, tokens: 1 },
    { model: 'gpt-5.6-sol', effort: 'low', requests: 1, tokens: 1 },
  ]);
  const rows = parseRows(html);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].model, 'GPT-5.6 Sol');
  assert.match(rows[0].color, /^hsl\(/);
  const rest = rows.slice(1);
  for (const row of rest) assert.match(row.color, /^#[0-9a-f]{6}$/);
  const labels = rest.map((r) => r.model);
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)));
});

// The summary row at the bottom of the top-models table aggregates
// requests by canonical real_model so the user can see how much each
// upstream model actually served, regardless of which alias the
// caller used. Both 'haiku' and 'minimax' aliases route to MiniMax-M3
// here — the summary should report MiniMax-M3: 1234 reqs.
//
// The summary reads from `data.totalsByRealModel`, which the server
// returns from a separate, no-LIMIT query so it isn't truncated by
// topModels' top-5 cutoff.
test('renders totals per real_model summary aggregating across aliases', async () => {
  const { context, modelRows } = appHarness();
  context.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    json: async () => ({
      range: '7d',
      tokensByBucket: [],
      requestsByHourOfDay: [],
      cacheHitRateByModel: [],
      topModels: [
        { model: 'claude-haiku-4-5', real_model: 'MiniMax-M3', requests: 1000,
          input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
          thinking: 0, errors: 0 },
        { model: 'minimax', real_model: 'MiniMax-M3', requests: 234,
          input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
          thinking: 0, errors: 0 },
        { model: 'claude-opus-5-5', real_model: 'claude-opus-5-5', requests: 50,
          input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
          thinking: 0, errors: 0 },
      ],
      totalsByRealModel: [
        { real_model: 'MiniMax-M3', requests: 1234, input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0, thinking: 0, errors: 0 },
        { real_model: 'claude-opus-5-5', requests: 50, input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0, thinking: 0, errors: 0 },
      ],
      topSessions: [],
      errorsByStatus: [],
      rangeTotals: { requests: 1284, input_tokens: 3, output_tokens: 3, cache_read: 0, cache_write: 0, thinking: 0 },
    }),
  });
  vm.runInNewContext(appSource, context, { filename: 'stats/public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(modelRows.innerHTML, /Total served per real model/);
  // MiniMax-M3 served 1000 (haiku) + 234 (minimax) = 1234, abbrev'd to 1.2k.
  assert.match(modelRows.innerHTML, /MiniMax-M3 1\.2k reqs/);
  // claude-opus's no-redirect bucket counts under "Opus" canonical name.
  assert.match(modelRows.innerHTML, /Opus 5.5 50 reqs/);
});
