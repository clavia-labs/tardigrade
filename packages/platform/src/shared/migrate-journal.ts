import { Schema } from "effect"
import { decodeReference, encodeReference } from "@tardie/grove"
import { legacyStore, type SyncSqlite, type SyncStore, type SyncOptions, type Transaction } from "@tardie/grove/sqlite"
import { encodeCheckpoint, PendingEffectInput, effectKey, type Recorded } from "@clavia/tardigrade-core"
import { storedPayloadBytes, storedPayloadDigest, type StoredPayloadRow, type StoredPayloadChunk } from "./stored-journal-payloads"
import { checkpointFromJson } from "@clavia/tardigrade-core/services/checkpoint"

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

// journalMigration converts retained 0.50 materials without rewriting event rows (test/workerd/migration.workers.ts).
export function journalMigration(driver: SyncSqlite, grove: SyncStore, actor: string, scope: string, chunkBytes: number, inputBytes: (key: string) => number, readerOptions: Omit<SyncOptions, "scope"> = {}) {
  const exists = (table: string) => driver.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]).length !== 0
  let oldStore: ReturnType<typeof legacyStore> | undefined
  const legacy = () => oldStore ??= legacyStore(driver, scope, readerOptions)
  const selection = (value: unknown) => {
    if (!object(value)) throw new Error("Invalid legacy input selection")
    if (value.reference !== undefined) return value
    const { target, ...source } = value
    return { reference: encodeReference(legacy().reference(source)), target }
  }
  const request = (value: unknown) => {
    if (!object(value)) throw new Error("Invalid legacy request")
    if (value.selections === undefined) return value
    const previous = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(value.selections)
    const selections = previous.map(selection)
    return selections.every((value, index) => value === previous[index]) ? value : { ...value, selections }
  }
  const event = <Event extends object>(record: Recorded<Event>): Recorded<Event> => {
    const value = record.event
    if (!object(value) || value.type !== "EffectRequested") return record
    const selections = object(value.request) ? value.request.selections : undefined
    if (!Array.isArray(selections) || !selections.some(value => object(value) && value.reference === undefined && value.root !== undefined)) return record
    const migrated = request(value.request)
    return migrated === value.request ? record : { ...record, event: { ...value, request: migrated } as Event }
  }
  const migrate = (tx: Transaction) => {
    const tree = exists("checkpoint_trees") ? tx.execute("SELECT position FROM checkpoint_trees WHERE actor=?", [actor])[0] : undefined
    const byteCheckpoint = exists("checkpoint") ? tx.execute("SELECT position,byte_length,chunk_count,digest FROM checkpoint WHERE id=1", [])[0] : undefined
    const inputs = exists("effect_inputs") ? tx.execute("SELECT ref,byte_length,chunk_count,digest FROM effect_inputs WHERE actor=? ORDER BY ref", [actor]) : []
    if (!tree && !byteCheckpoint && !inputs.length) return
    if (byteCheckpoint && tx.execute("SELECT DISTINCT actor FROM experimental_events", []).some(row => row.actor !== actor)) throw new Error("Unscoped legacy checkpoint requires an unambiguous actor")
    if (tx.execute("SELECT actor FROM stored_journal_checkpoints WHERE actor=?", [actor]).length || tx.execute("SELECT actor FROM stored_journal_inputs WHERE actor=?", [actor]).length) throw new Error("Conflicting legacy and native journal materials")
    const statePrefix = JSON.stringify([actor, "state"]).slice(0, -1) + ","
    const checkpointPrefix = JSON.stringify([actor, "checkpoint-state"])
    const checkpointOwner = JSON.stringify([actor, "checkpoint"])
    const inputPrefix = JSON.stringify([actor, "input"]).slice(0, -1) + ","
    const oldOwners = exists("grove_owners") ? tx.execute("SELECT name,root FROM grove_owners", []).filter(row => row.name === checkpointOwner || String(row.name).startsWith(statePrefix) || String(row.name).startsWith(checkpointPrefix) || String(row.name).startsWith(inputPrefix) || String(row.name).startsWith(JSON.stringify([actor, "view"]))) : []
    for (const owner of oldOwners) legacy().copy(tx, legacy().reference({ root: owner.root, path: [] }))
    const decode = (row: Record<string, unknown>, table: string, key?: string) => {
      const payload = storedPayloadBytes({ ...row, payload: new Uint8Array() } as unknown as StoredPayloadRow, () => tx.execute(`SELECT ordinal,payload FROM ${table}${key === undefined ? "" : " WHERE actor=? AND ref=?"} ORDER BY ordinal`, key === undefined ? [] : [actor, key]) as unknown as readonly StoredPayloadChunk[])
      if (storedPayloadDigest(payload) !== row.digest) throw new Error("Legacy journal payload digest mismatch")
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown
    }
    const write = (table: string, key: string | undefined, payload: Uint8Array, position?: number) => {
      const digest = storedPayloadDigest(payload), size = key === undefined ? chunkBytes : inputBytes(key)
      const count = Math.ceil(payload.byteLength / size)
      if (key === undefined) tx.execute("INSERT INTO stored_journal_checkpoints(actor,position,payload,digest,byte_length,chunk_count) VALUES(?,?,?,?,?,?)", [actor, position!, new Uint8Array(), digest, payload.byteLength, count])
      else tx.execute("INSERT INTO stored_journal_inputs(actor,ref,input,byte_length,chunk_count,digest) VALUES(?,?,?,?,?,?)", [actor, key, "", payload.byteLength, count, digest])
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const part = payload.subarray(ordinal * size, Math.min(payload.byteLength, (ordinal + 1) * size))
        tx.execute(`INSERT INTO ${table}(actor,${key === undefined ? "" : "ref,"}ordinal,payload) VALUES(${key === undefined ? "?,?,?" : "?,?,?,?"})`, key === undefined ? [actor, ordinal, part] : [actor, key, ordinal, part])
      }
    }
    let checkpoint: unknown
    if (tree) {
      const owner = oldOwners.find(owner => owner.name === checkpointOwner)
      if (!owner) throw new Error("Missing legacy checkpoint owner")
      checkpoint = legacy().read(String(owner.root))
    } else if (byteCheckpoint) checkpoint = decode(byteCheckpoint, "checkpoint_chunks")
    if (checkpoint !== undefined) {
      if (!object(checkpoint) || !Array.isArray(checkpoint.durable)) throw new Error("Invalid legacy checkpoint")
      const durable = checkpoint.durable.map(value => {
        if (!object(value)) throw new Error("Invalid legacy durable entry")
        if (value.tree === undefined) return value
        if (!object(value.state) || value.state._tag !== "TreeState" || value.state.root !== value.tree || typeof value.tree !== "string") throw new Error("Invalid legacy durable tree")
        const { tree: _tree, ...entry } = value
        return { ...entry, state: legacy().read(value.tree) }
      })
      const operations = (values: unknown) => Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(values).map(value => {
        if (!object(value) || !object(value.request)) throw new Error("Invalid legacy operation")
        return { ...value, request: { ...value.request, request: request(value.request.request) } }
      })
      const transformed = { ...checkpoint, durable, ...(checkpoint.operations === undefined ? { effects: operations(checkpoint.effects) } : { operations: operations(checkpoint.operations) }) }
      const saved = checkpointFromJson(transformed)
      if (saved.position !== Number((tree ?? byteCheckpoint)!.position)) throw new Error("Legacy checkpoint position mismatch")
      if (saved.position > Number(tx.execute("SELECT COUNT(*) count FROM experimental_events WHERE actor=?", [actor])[0]!.count)) throw new Error("Legacy checkpoint exceeds journal length")
      const payload = encodeCheckpoint(saved)
      write("stored_journal_checkpoint_chunks", undefined, payload, saved.position)
      grove.replaceOwners(tx, JSON.stringify([actor, "checkpoint"]) + "/", saved.operations.flatMap(operation => operation.request.request.selections?.map(selected => decodeReference(selected.reference)) ?? []))
    }
    for (const row of inputs) {
      const key = String(row.ref), raw = decode(row, "effect_input_chunks", key)
      if (!object(raw)) throw new Error("Invalid legacy accepted input")
      const input = Schema.decodeUnknownSync(PendingEffectInput, { onExcessProperty: "error" })({ ...raw, request: request(raw.request) })
      if (effectKey(input.ref) !== key || input.ref.act !== input.request.act) throw new Error("Legacy accepted input identity mismatch")
      for (const selected of input.request.selections ?? []) legacy().copy(tx, decodeReference(selected.reference))
      grove.replaceOwners(tx, JSON.stringify([actor, "input", key]) + "/", input.request.selections?.map(selected => decodeReference(selected.reference)) ?? [])
      write("stored_journal_input_chunks", key, new TextEncoder().encode(JSON.stringify(input)))
    }
    if (tree) tx.execute("DELETE FROM checkpoint_trees WHERE actor=?", [actor])
    if (byteCheckpoint) { tx.execute("DELETE FROM checkpoint_chunks", []); tx.execute("DELETE FROM checkpoint WHERE id=1", []) }
    if (inputs.length) { tx.execute("DELETE FROM effect_input_chunks WHERE actor=?", [actor]); tx.execute("DELETE FROM effect_inputs WHERE actor=?", [actor]) }
    for (const owner of oldOwners) tx.execute("DELETE FROM grove_owners WHERE name=?", [String(owner.name)])
    if (exists("grove_owners")) legacy().collect(tx)
    oldStore = undefined
  }
  return { event, migrate }
}
