import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('./app.js', import.meta.url), 'utf8');

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
    tokensByDay: [],
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
    Chart: class {},
    localStorage: { getItem() { return null; }, setItem() {} },
    setInterval() {},
    console,
  };
  return { context, modelRows };
}

test('renders human-readable labels for the supported model aliases', async () => {
  const { context, modelRows } = appHarness();
  vm.runInNewContext(appSource, context, { filename: 'stats/public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  for (const label of ['Opus 5', 'Sonnet 5', 'GPT-5.6 Luna', 'GPT-5.6 Terra', 'GPT-5.6 Sol', 'GPT-6 Astra']) {
    assert.ok(modelRows.innerHTML.includes(`>${label}<`), `missing rendered label: ${label}`);
  }
});
