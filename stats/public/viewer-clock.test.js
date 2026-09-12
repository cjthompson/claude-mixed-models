import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'viewer-clock.js'), 'utf8');
function clock() { const c = {}; vm.runInNewContext(source, c); return c.ViewerClock.create('America/Denver'); }

test('ViewerClock projects UTC buckets into explicit Denver local time', () => {
  const c = clock();
  assert.equal(c.localDay('2026-09-12T00:00:00.000Z'), '2026-09-11');
  assert.equal(c.localTime('2026-09-12T00:00:00.000Z'), '18:00');
});

test('ViewerClock handles DST gaps and fallback aggregation', () => {
  const c = clock();
  assert.notEqual(c.localHour('2026-03-08T09:30:00.000Z'), '02');
  const out = c.normalizeDashboard({ range: 'all', tokensByBucket: [
    { bucket: '2026-11-01T07:30:00.000Z', model: 'm', tokens: 2 },
    { bucket: '2026-11-01T08:30:00.000Z', model: 'm', tokens: 3 },
  ], requestsByHourOfDay: [
    { bucket: '2026-11-01T07:00:00.000Z', requests: 4 },
    { bucket: '2026-11-01T08:00:00.000Z', requests: 5 },
  ] });
  assert.equal(out.tokenChart.labels.join(','), '2026-11-01');
  assert.equal(out.tokenChart.buckets[0].models.m, 5);
  assert.equal(out.requestHourChart.values[1], 9);
});

test('ViewerClock preserves multiple models in one UTC bucket', () => {
  const out = clock().normalizeDashboard({ range: '24h', tokensByBucket: [
    { bucket: '2026-09-12T00:00:00.000Z', model: 'm1', tokens: 2 },
    { bucket: '2026-09-12T00:00:00.000Z', model: 'm2', tokens: 3 },
  ], requestsByHourOfDay: [] }, { now: new Date('2026-09-12T00:00:00Z') });
  const bucket = out.tokenChart.buckets.find((b) => b.models.m1);
  assert.equal(bucket.models.m1, 2);
  assert.equal(bucket.models.m2, 3);
});

test('ViewerClock synthesizes all 24 fixed-now hourly buckets', () => {
  const out = clock().normalizeDashboard({ range: '24h', tokensByBucket: [], requestsByHourOfDay: [] }, {
    now: new Date('2026-09-12T00:23:00.000Z'),
  });
  assert.equal(out.tokenChart.labels.length, 24);
  assert.equal(out.tokenChart.buckets.length, 24);
});
