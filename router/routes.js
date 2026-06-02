// Resolve an inbound model name to an upstream + the upstream's real model id.
// Returns null when the model isn't in the table (caller should 400).
export function resolveRoute(model, table) {
  const route = table[model];
  if (!route) return null;
  return { upstream: route.upstream, realModel: route.realModel };
}
