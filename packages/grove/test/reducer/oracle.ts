import { Schema } from "effect"
import type { Grove, Json, Reference, Transaction } from "../../src/reducer"

export const actions = ["insert", "edit", "delete", "move", "duplicate", "reverse", "clone", "mirror", "fromMirror", "reuseArray", "clear"] as const
const State = Schema.Struct({ items: Schema.Array(Schema.Json), mirror: Schema.Array(Schema.Json) })
const Event = Schema.Struct({ type: Schema.Literals(actions), from: Schema.Int, to: Schema.Int, value: Schema.Json })
export interface Instruction { readonly event: typeof Event.Type; readonly observe: boolean; readonly publish: boolean; readonly restart: boolean; readonly rollback: boolean; readonly collect: boolean; readonly release: boolean }

// reduce defines the plain authoring oracle without Grove storage or matching logic.
function reduce(state: typeof State.Type, event: typeof Event.Type): typeof State.Type {
  const items = state.items.slice(), from = event.from % Math.max(1, items.length), to = event.to % (items.length + 1)
  switch (event.type) {
    case "insert": items.splice(to, 0, event.value); break
    case "edit": if (items.length) { const old = items[from]!; items[from] = old !== null && typeof old === "object" && !Array.isArray(old) ? { ...old, changed: event.value } : event.value }; break
    case "delete": items.splice(from, 1); break
    case "move": if (items.length) { const [value] = items.splice(from, 1); items.splice(event.to % (items.length + 1), 0, value!) }; break
    case "duplicate": if (items.length) items.splice(to, 0, items[from]!); break
    case "reverse": items.reverse(); break
    case "clone": return JSON.parse(JSON.stringify(state)) as typeof State.Type
    case "mirror": return { items: state.items, mirror: state.items }
    case "fromMirror": if (state.mirror.length) items.push(state.mirror[event.from % state.mirror.length]!); break
    case "reuseArray": return { items: state.mirror, mirror: state.mirror }
    case "clear": return { items: [], mirror: state.mirror }
  }
  return { items, mirror: state.mirror }
}

const check = (condition: boolean, message: string) => { if (!condition) throw new Error(`Oracle: ${message}`) }
const snapshot = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// runHistory compares staging, publication, replay and retained inputs with a plain JSON fold.
export function runHistory(create: () => Grove, instructions: readonly Instruction[]) {
  const definition = { name: "oracle", schema: State, input: Event, initial: { items: [], mirror: [] }, reduce }
  let grove = create(), state = grove.materialize(definition), current = state.initial()
  let plain: typeof State.Type = { items: [], mirror: [] }, committed: Json | undefined, committedCount = 0
  const records: { sequence: number; event: typeof Event.Type }[] = []
  const inputs: { owner: string; reference: Reference<typeof State.Type>; value: Json; sequence: number; pending: boolean }[] = []
  const released: Reference<typeof State.Type>[] = []
  grove.transaction(tx => tx.execute("CREATE TABLE oracle_events(seq INTEGER PRIMARY KEY,event TEXT NOT NULL)", []))
  const checkHead = () => {
    const head = state.head()
    check(committedCount === 0 ? head === null : head !== null && equal(head.value, committed) && head.sequence === records[committedCount - 1]!.sequence, "committed state/sequence")
  }
  const flush = (fail: boolean) => {
    const expected = state.head()?.reference ?? null
    const publish = (tx: Transaction) => {
      for (const record of records.slice(committedCount)) tx.execute("INSERT INTO oracle_events VALUES(?,?)", [record.sequence, JSON.stringify(record.event)])
      state.publish(tx, current, { expected })
      for (const input of inputs) if (input.pending) grove.retain(tx, input.owner, input.reference)
    }
    if (fail) {
      let failed = false
      try { grove.transaction(tx => { publish(tx); throw new Error("Injected rollback") }) } catch { failed = true }
      check(failed, "rollback injection"); checkHead()
    }
    grove.transaction(publish)
    committed = snapshot(plain); committedCount = records.length
    for (const input of inputs) input.pending = false
    grove.discard(); checkHead()
    grove.transaction(tx => {
      const journal = tx.execute("SELECT seq,event FROM oracle_events ORDER BY seq", [])
      check(journal.length === committedCount && journal.every((row, i) => row.seq === records[i]!.sequence && row.event === JSON.stringify(records[i]!.event)), "immutable journal")
    })
  }
  for (const [i, instruction] of instructions.entries()) {
    const record = { sequence: 2 * i + 1, event: instruction.event, metadata: null }
    plain = reduce(plain, record.event); records.push(record)
    current = state.apply(current, record)
    check(equal(current.value, plain), "staged reducer result")
    if (instruction.observe) inputs.push({ owner: `input/${i}`, reference: current.reference, value: snapshot(plain), sequence: record.sequence, pending: true })
    if (instruction.publish || instruction.restart || instruction.release || i === instructions.length - 1) flush(instruction.rollback)
    if (instruction.release && inputs.length) {
      const input = inputs.shift()!
      grove.transaction(tx => grove.release(tx, input.owner, { expected: input.reference })); released.push(input.reference)
    }
    if (instruction.collect) grove.collect()
    if (instruction.restart) { grove = create(); state = grove.materialize(definition); current = state.head()!; checkHead() }
    for (const input of inputs) { const old = state.open(input.reference); check(equal(old.value, input.value) && old.sequence === input.sequence, "retained input") }
  }
  grove.transaction(tx => { for (const input of inputs) { grove.release(tx, input.owner, { expected: input.reference }); released.push(input.reference) } })
  grove.discard(); grove.collect(); checkHead()
  const head = state.head()?.reference
  for (const reference of released) if (reference !== head) {
    let expired = false
    try { state.open(reference) } catch { expired = true }
    check(expired, "released reference reclamation")
  }
  return { events: records.length, releasedInputs: released.length, finalState: snapshot(plain) }
}
