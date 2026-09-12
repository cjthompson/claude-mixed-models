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
      { bucket: '2026-09-12T00:00:00.000Z', model: 'claude-opus-5', tokens: 2 },
      { bucket: '2026-09-12T00:00:00.000Z', model: 'claude-sonnet-5', tokens: 3 },
    ],
    requestsByHourOfDay: [],
    cacheHitRateByModel: [],
    topModels: [
      row('claude-opus-5'),
      row('claude-sonnet-5'),
      row('gpt-5.6-luna'),
      row('gpt-5.6-terra'),
      row('gpt-5.6-sol'),
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

  for (const label of ['Opus 5', 'Sonnet 5', 'GPT-5.6 Luna', 'GPT-5.6 Terra', 'GPT-5.6 Sol', 'GPT-6 Astra']) {
    assert.ok(modelRows.innerHTML.includes(`>${label}<`), `missing rendered label: ${label}`);
  }
});

test('renders normalized token buckets for multiple models', async () => {
  const { context, charts } = appHarness();
  vm.runInNewContext(appSource, context, { filename: 'stats/public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tokenChart = charts.find((chart) => chart.data.datasets.some((d) => d.label === 'Opus 5'));
  assert.ok(tokenChart);
  assert.deepEqual([...tokenChart.data.datasets.map((d) => d.label)].sort(), ['Opus 5', 'Sonnet 5']);
  assert.deepEqual([...tokenChart.data.datasets.map((d) => d.data[0])], [2, 3]);
});
