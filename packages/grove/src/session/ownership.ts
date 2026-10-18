// localOwners tracks named values until their holder replaces or releases them (test/sqlite-sync.test.ts; core/properties/durable-state.test.ts).
export function localOwners<Value>(identity: (value: Value) => string) {
  const holders = new Map<object, Map<string, Value>>()
  return {
    hold: (holder: object, name: string, value: Value) => {
      let values = holders.get(holder)
      if (!values) { values = new Map(); holders.set(holder, values) }
      values.set(name, value)
    },
    release: (holder: object) => { holders.delete(holder) },
    held: (): readonly Value[] => [...new Map([...holders.values()].flatMap(values => [...values.values()].map(value => [identity(value), value] as const))).values()],
    get size() { return holders.size },
  }
}
