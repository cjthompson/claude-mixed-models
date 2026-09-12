// Browser-local time projection for dashboard payloads. This is a classic
// script so it can be loaded before app.js without a module loader.
(function installViewerClock(global) {
  const cache = new Map();
  const formatter = (timeZone) => {
    if (!cache.has(timeZone)) cache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', formatMatcher: 'basic',
    }));
    return cache.get(timeZone);
  };
  const parts = (fmt, value) => Object.fromEntries(fmt.formatToParts(new Date(value))
    .filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));

  function create(timeZone) {
    if (typeof timeZone !== 'string' || !timeZone) throw new TypeError('timeZone is required');
    const fmt = formatter(timeZone);
    const clock = {
      timeZone,
      localDay(utcBucket) { const p = parts(fmt, utcBucket); return `${p.year}-${p.month}-${p.day}`; },
      localHour(utcBucket) { return parts(fmt, utcBucket).hour; },
      localTime(utcBucket) { const p = parts(fmt, utcBucket); return `${p.hour}:${p.minute}`; },
      normalizeDashboard(payload, { now = new Date() } = {}) {
        const range = payload.range ?? '7d';
        const short = range === '1h' || range === '5h';
        const hourly = range === '24h';
        const dayLabels = !short && !hourly;
        const rows = [...(payload.tokensByBucket ?? [])].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
        const byBucket = new Map();
        for (const r of rows) {
          const bucket = byBucket.get(r.bucket) ?? { bucket: r.bucket, models: {} };
          if (r.model != null) bucket.models[r.model] = (bucket.models[r.model] ?? 0) + Number(r.tokens ?? 0);
          byBucket.set(r.bucket, bucket);
        }
        if (hourly) {
          const end = new Date(now); end.setUTCMinutes(0, 0, 0);
          for (let i = 23; i >= 0; i--) { const d = new Date(end); d.setUTCHours(d.getUTCHours() - i); const bucket = d.toISOString(); if (!byBucket.has(bucket)) byBucket.set(bucket, { bucket, models: {} }); }
        }
        const grouped = new Map();
        for (const r of [...byBucket.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)))) {
          const label = dayLabels ? clock.localDay(r.bucket) : clock.localTime(r.bucket);
          let item = grouped.get(label);
          if (!item) { item = { label, models: {} }; grouped.set(label, item); }
          for (const [model, tokens] of Object.entries(r.models ?? {})) item.models[model] = (item.models[model] ?? 0) + tokens;
        }
        const tokenChart = {
          title: short ? 'Tokens per 5m' : hourly ? 'Tokens per hour' : 'Tokens per day',
          labels: [...grouped.keys()], buckets: [...grouped.values()],
        };
        const requestValues = new Array(24).fill(0);
        for (const r of payload.requestsByHourOfDay ?? []) requestValues[Number(clock.localHour(r.bucket))] += Number(r.requests ?? 0);
        return { ...payload, tokenChart, requestHourChart: {
          labels: requestValues.map((_, i) => String(i).padStart(2, '0')), values: requestValues,
        } };
      },
    };
    return Object.freeze(clock);
  }
  global.ViewerClock = Object.freeze({
    create,
    fromBrowser() { return create(new Intl.DateTimeFormat().resolvedOptions().timeZone); },
  });
})(globalThis);
