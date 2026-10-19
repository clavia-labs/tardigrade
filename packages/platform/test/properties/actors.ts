import fc from "fast-check"
import { Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { atom, createEventLog, type RecordMetadata } from "@clavia/tardigrade-core"
import { storedSession } from "@clavia/tardigrade-core/services/stored-session"
import { decodeReference, encodeReference, tree, type Json } from "@tardie/grove"
import { makeSync, type SyncSqlite } from "@tardie/grove/sqlite"
import { Event } from "@clavia/tardigrade-agent/contracts/events"
import { agentDurableAtoms } from "@clavia/tardigrade-agent/atoms/durable/atoms"
import { inferState, initialInference, inferenceState, findTurn, readInference, InferenceState, inferenceCollections } from "@clavia/tardigrade-agent/atoms/durable/inference"
import { spendState, SpendState } from "@clavia/tardigrade-agent/atoms/durable/spend"
import { reducePermissions, permissionState, PermissionState } from "@clavia/tardigrade-agent/atoms/durable/permissions"
import { reduceBudget, budgetState } from "@clavia/tardigrade-agent/atoms/durable/budget"
import { toolState, pendingTools, ToolState } from "@clavia/tardigrade-agent/atoms/durable/tools"
import { codeModeState, executions, CodeModeState } from "@clavia/tardigrade-agent/atoms/durable/code-mode"

import { reduceSpend } from "../fixtures/agent-oracles"

export const agentCollectionCases = fc.record({ turns: fc.array(fc.record({ text: fc.string(), allowed: fc.boolean(), unknownCost: fc.boolean(), missingTime: fc.boolean() }), { minLength: 2, maxLength: 5 }), cacheBytes: fc.constantFrom(0, 1024, 32768), chunkBytes: fc.constantFrom(3, 4096), restore: fc.constantFrom("value", "plain", "legacy", "document") })
type Case = typeof agentCollectionCases extends fc.Arbitrary<infer Value> ? Value : never
const same = (actual: unknown, expected: unknown) => { if (!isDeepStrictEqual(actual, expected)) throw new Error(`Agent collections differ: ${JSON.stringify({ actual, expected })}`) }

// agentCollections compares Grove projections with reducer models through native commits, collection and reopen (bun/actors.test.ts; workerd/actors.workers.ts).
export function agentCollections(driver: SyncSqlite, options: Case) {
  const storage = { scope: "agent-collections", cacheBytes: options.cacheBytes, chunkBytes: options.chunkBytes }, open = () => makeSync(driver, storage)
  let store = open()
  const atoms = { inferenceState, spendState, permissionState, budgetState, pendingTools, executions, all: atom(get => { for (const node of agentDurableAtoms) get(node); return null }) }
  let log = createEventLog({ schema: Event, atoms, documents: storedSession(store) }), snapshot = log.initial
  let inference = initialInference, spend = spendStateValue(), permissions: ReturnType<typeof reducePermissions> = { policy: null, decisions: [] }, budget: ReturnType<typeof reduceBudget> = [], tools: ReturnType<typeof toolState> = { queue: [], pending: null, origin: null, running: false }, code: ReturnType<typeof codeModeState> = []
  const verify = () => {
    snapshot.get(atoms.all)
    same(snapshot.get(spendState), spend); const lookup = snapshot.get(permissionState); same(lookup.policy, permissions.policy); same(lookup.decision("tool.execute", "never-requested"), undefined)
    for (const { action, requestId } of permissions.decisions) same(lookup.decision(action, requestId), permissions.decisions.findLast(entry => entry.action === action && entry.requestId === requestId)!.decision)
    same(snapshot.get(budgetState), budget); same(snapshot.get(pendingTools), tools); same(snapshot.get(executions), code)
    same(readInference(snapshot.get(inferenceState)), { ...inference, turns: inference.turns.filter(turn => turn.settlement === null) })
    for (const turn of inference.turns) same(findTurn(snapshot.get(inferenceState), turn.turnId), turn)
  }
  const apply = (event: Event, metadata: RecordMetadata = {}) => {
    const position = snapshot.position
    inference = inferState(inference, event, metadata, position); spend = reduceSpend(spend, event, metadata); permissions = reducePermissions(permissions, event); budget = reduceBudget(budget, event); tools = toolState(tools, event, metadata, position); code = codeModeState(code, event, metadata, position)
    snapshot = log.append(snapshot, event, metadata); verify()
  }
  const legacyValue = (name: string, value: Json): Json => {
    if (name === "agent.inference.state") return inference
    if (name === "agent.spend") return spend
    if (name === "agent.permissions.decisions") return permissions
    if (name === "agent.budget") return budget
    if (name === "agent.tools.pending") return tools
    if (name === "agent.code-mode.executions") return code
    return value
  }
  const reopen = () => {
    let checkpoint = snapshot.checkpoint()!
    same(checkpoint.durable.length, agentDurableAtoms.length)
    for (const entry of checkpoint.durable) {
      if (!entry.reference || !Schema.is(Schema.TaggedStruct("DocumentState", { reference: Schema.String }))(entry.state)) throw new Error(`Unexpected agent checkpoint: ${entry.name}`)
    }
    store.transaction(tx => store.commit(tx, { publish: checkpoint.durable.flatMap(entry => entry.reference ? [{ owner: entry.name, expected: store.owner(entry.name), document: decodeReference(entry.reference) }] : []) }))
    checkpoint = { ...checkpoint, durable: checkpoint.durable.map(entry => {
      const current = store.readValue(decodeReference(entry.reference!))
      if (options.restore === "value") return { name: entry.name, position: entry.position, state: { _tag: "ValueState", value: current } }
      const state = options.restore === "legacy" ? legacyValue(entry.name, current) : previousValue(entry.name, current)
      if (options.restore === "plain" || options.restore === "legacy") return { name: entry.name, position: entry.position, state }
      const reference = store.bind(tree(Schema.suspend(() => Schema.Json))).initial(state).reference
      store.transaction(tx => store.commit(tx, { publish: [{ owner: entry.name, expected: store.owner(entry.name), document: reference }] }))
      return { ...entry, state: { _tag: "DocumentState", reference: encodeReference(reference) }, reference: encodeReference(reference) }
    }) }
    log.dispose(); store.discard(); store.collect(); store = open()
    log = createEventLog({ schema: Event, atoms, documents: storedSession(store), checkpoint }); snapshot = log.initial; verify()
  }
  const model = { model: { provider: "test", model_id: "test" }, contextWindowTokens: 4096 }
  try {
    apply({ type: "ModelConfigured", ...model })
    apply({ type: "PermissionConfigured", policy: { default: "ask", actions: {} } })
    apply({ type: "BudgetConfigured", metric: "toolCalls", policy: { limit: 2 } })
    for (const [index, item] of options.turns.entries()) {
      const turnId = ["__proto__", "2", "1", "constructor", "界"][index]!, metadata = item.missingTime ? {} : { recordedAt: index * 100 + 10 }
      apply({ type: "TurnRequested", turnId, text: item.text, invocationRef: { method: "message", id: turnId } }, metadata)
      apply({ type: "ModelCalled", purpose: "inference", ...model, turnId, callId: inference.callId }, metadata)
      const calls = ["2", "1"].map(id => ({ callId: `${index}:${id}`, providerId: id, name: "lookup", input: { id } }))
      apply({ type: "ModelReturned", purpose: "inference", callId: inference.callId, text: "", toolCalls: calls, usage: { input: 3, output: 2, usd: item.unknownCost ? null : 0.1 } }, metadata)
      reopen()
      for (const call of calls) {
        apply({ type: "PermissionResolved", action: "tool.execute", requestId: call.callId, decision: { allowed: item.allowed, reason: item.text } }, metadata)
        apply({ type: "PermissionResolved", action: "tool.execute", requestId: call.callId, decision: { allowed: !item.allowed, reason: "changed" } }, metadata)
        apply({ type: "ToolCalled", callId: call.callId, counted: item.allowed }, metadata)
        reopen()
        apply({ type: "ToolReturned", callId: call.callId, version: 1, content: [{ type: "text", text: item.text }], error: null }, metadata)
      }
      apply({ type: "ModelCalled", purpose: "inference", ...model, turnId, callId: inference.callId }, metadata)
      const callId = inference.callId
      apply({ type: "ModelReturned", purpose: "inference", callId, text: item.text, toolCalls: [] }, metadata)
      apply({ type: "TurnSettled", turnId, outcome: "completed", callId }, { recordedAt: index * 100 + 80 })
      reopen()
    }
  } finally { log.dispose(); store.discard() }
}
function spendStateValue(): ReturnType<typeof reduceSpend> { return { toolSpend: [], tokenSpend: [], usdSpend: [], timeSpend: [], timers: [], turns: [], models: [], tools: [] } }

// previousValue recreates checkpoint payloads emitted before whole-value agent state (bun/actors.test.ts; workerd/actors.workers.ts).
function previousValue(name: string, state: Json): Json {
  const keyed = (field: string) => Object.fromEntries(Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Json)))(state).map(entry => [String(entry[field]), entry]))
  if (name === "agent.inference.state") {
    return inferenceCollections(Schema.decodeUnknownSync(InferenceState)(state))
  }
  if (name === "agent.spend") {
    const spend = Schema.decodeUnknownSync(SpendState)(state)
    return { totals: Object.fromEntries(spend.toolSpend.map(tool => [JSON.stringify(tool.turnId), { ...tool, input: spend.tokenSpend.find(turn => turn.turnId === tool.turnId)!.input, output: spend.tokenSpend.find(turn => turn.turnId === tool.turnId)!.output, usd: spend.usdSpend.find(turn => turn.turnId === tool.turnId)!.usd, ms: spend.timeSpend.find(turn => turn.turnId === tool.turnId)!.ms, startedAt: spend.timers.find(turn => turn.turnId === tool.turnId)?.startedAt ?? null }])), pending: spend.turns, models: Object.fromEntries(spend.models.map(call => [call.callId, call.turnId])), tools: Object.fromEntries(spend.tools.map(call => [call.callId, call.turnId])) }
  }
  if (name === "agent.permissions.decisions") {
    const value = Schema.decodeUnknownSync(PermissionState)(state)
    return { policy: value.policy, decisions: Object.fromEntries(value.decisions.map((entry, index) => [`import:${index}`, entry]).reverse()), latest: Object.fromEntries(value.decisions.map((entry, index) => [JSON.stringify([entry.action, entry.requestId]), `import:${index}`])) }
  }
  if (name === "agent.budget") return keyed("metric")
  if (name === "agent.promises.submissions") return keyed("callId")
  if (name === "agent.code-mode.executions") return Object.fromEntries(Schema.decodeUnknownSync(CodeModeState)(state).map(entry => [entry.call.callId, entry]))
  if (name === "agent.tools.pending") {
    const value = Schema.decodeUnknownSync(ToolState)(state)
    return { ...value, queue: Object.fromEntries(value.queue.map(entry => [entry.call.callId, entry])), order: value.queue.map(entry => entry.call.callId) }
  }
  return state
}
