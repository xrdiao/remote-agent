// An index belongs to one view construction; it is never retained across mutations.
export function indexFusionRun(run) {
  const indexes = new Map();
  return (collection, key = 'id') => {
    const name = `${collection}:${key}`;
    if (!indexes.has(name)) indexes.set(name, new Map(run[collection].map(row => [row[key], row])));
    return indexes.get(name);
  };
}
