// keyedChanges emits additions, replacements and removals between keyed reducer results (platform/test/properties/agent-collections.ts).
export function keyedChanges<Value>(before: readonly Value[], after: readonly Value[], key: (value: Value) => string): readonly (readonly [string, Value | undefined])[] {
  const previous = new Map(before.map(value => [key(value), value])), next = new Map(after.map(value => [key(value), value]))
  return [...[...previous.keys()].filter(key => !next.has(key)).map(key => [key, undefined] as const), ...[...next].filter(([key, value]) => previous.get(key) !== value)]
}
