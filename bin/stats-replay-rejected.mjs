#!/usr/bin/env node
// Move batcher-rejected events back into the events file for another attempt.
//
//   node bin/stats-replay-rejected.mjs --match 'NOT NULL' [--dry-run]
//   node bin/stats-replay-rejected.mjs --all
//
// In the container:
//   docker exec claude-mixed-models_router_1 node bin/stats-replay-rejected.mjs --match <regex>
//
// Only replay after fixing whatever made the records fail; otherwise the
// batcher rejects them again. See lib/replay-rejected.js.

import { parseArgs } from 'node:util';
import { eventsPath, otherEventsPath } from '../lib/event.js';
import { replayRejected } from '../lib/replay-rejected.js';

const { values } = parseArgs({
  options: {
    match:    { type: 'string' },
    all:      { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    events:   { type: 'string' },
    rejected: { type: 'string' },
  },
});

if (!values.all && values.match === undefined) {
  console.error('Pass --match <regex> (against rejectReason) or --all.');
  process.exit(2);
}

const events = values.events ?? eventsPath();
const rejected = values.rejected ?? otherEventsPath(events);
const { replayed, kept } = replayRejected({
  eventsPath: events,
  rejectedPath: rejected,
  match: values.match === undefined ? undefined : new RegExp(values.match),
  all: values.all,
  dryRun: values['dry-run'],
});

console.log(`${values['dry-run'] ? 'would replay' : 'replayed'} ${replayed} record(s) from ${rejected} to ${events}; ${kept} left in place`);
