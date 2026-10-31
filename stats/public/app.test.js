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
