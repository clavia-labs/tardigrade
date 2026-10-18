// localOwners tracks named values until their holder replaces or releases them (test/transactions.test.ts; core/properties/durable-state.test.ts).
// Values are counted by identity; drain returns the identities that became held or unheld since the previous drain, and heldAt returns held values by key.
export function localOwners<Value>(identity: (value: Value) => string, key: (value: Value) => string = identity) {
  const holders = new Map<object, Map<string, Value>>()
  const live = new Map<string, { readonly value: Value; readonly key: string; count: number }>()
  const keyed = new Map<string, Map<string, Value>>()
  const added = new Map<string, Value>(), removed = new Set<string>()
  const acquire = (value: Value) => {
    const id = identity(value), entry = live.get(id)
    if (entry) { entry.count++; return }
    const group = key(value)
    live.set(id, { value, key: group, count: 1 })
    let values = keyed.get(group)
    if (!values) { values = new Map(); keyed.set(group, values) }
    values.set(id, value)
    if (!removed.delete(id)) added.set(id, value)
  }
  const drop = (value: Value) => {
    const id = identity(value), entry = live.get(id)!
    if (--entry.count) return
    live.delete(id)
    const values = keyed.get(entry.key)!
    values.delete(id)
    if (!values.size) keyed.delete(entry.key)
    if (!added.delete(id)) removed.add(id)
  }
  return {
    hold: (holder: object, name: string, value: Value) => {
      let values = holders.get(holder)
      if (!values) { values = new Map(); holders.set(holder, values) }
      const previous = values.get(name)
      values.set(name, value)
      acquire(value)
      if (previous !== undefined) drop(previous)
    },
    release: (holder: object) => {
      const values = holders.get(holder)
      if (!values) return
      holders.delete(holder)
      for (const value of values.values()) drop(value)
    },
    held: (): readonly Value[] => [...live.values()].map(entry => entry.value),
    heldAt: (group: string): readonly Value[] => [...keyed.get(group)?.values() ?? []],
    drain: () => {
      const changes = { added: [...added], removed: [...removed] }
      added.clear(); removed.clear()
      return changes
    },
    get size() { return holders.size },
  }
}
