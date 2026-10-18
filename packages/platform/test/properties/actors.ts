import fc from "fast-check"
import { Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { atom, createEventLog, type RecordMetadata } from "@clavia/tardigrade-core"
import { storedSession } from "@clavia/tardigrade-core/services/stored-session"
import { decodeReference } from "@tardie/grove"
import { makeSync, type SyncSqlite } from "@tardie/grove/sqlite"
import { Event } from "@clavia/tardigrade-agent/contracts/events"
import { agentDurableAtoms } from "@clavia/tardigrade-agent/atoms/durable/atoms"
import { inferState, initialInference, inferenceState, findTurn, readInference } from "@clavia/tardigrade-agent/atoms/durable/inference"
import { spendState } from "@clavia/tardigrade-agent/atoms/durable/spend"
import { reducePermissions, permissionState } from "@clavia/tardigrade-agent/atoms/durable/permissions"
import { reduceBudget, budgetState } from "@clavia/tardigrade-agent/atoms/durable/budget"
import { toolState, pendingTools } from "@clavia/tardigrade-agent/atoms/durable/tools"
import { codeModeState, executions } from "@clavia/tardigrade-agent/atoms/durable/code-mode"

import { reduceSpend } from "../fixtures/agent-oracles"

export const agentCollectionCases = fc.record({ turns: fc.array(fc.record({ text: fc.string(), allowed: fc.boolean(), unknownCost: fc.boolean(), missingTime: fc.boolean() }), { minLength: 2, maxLength: 5 }), cacheBytes: fc.constantFrom(0, 1024, 32768), chunkBytes: fc.constantFrom(3, 4096) })
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
    const view = snapshot.get(spendState); same(view.pending, spend.turns); same(view.models, spend.models); same(view.tools, spend.tools); same(view.turn("never-requested"), undefined)
    spend.toolSpend.forEach(({ turnId, count }, index) => same(view.turn(turnId), { turnId, count, input: spend.tokenSpend[index]!.input, output: spend.tokenSpend[index]!.output, usd: spend.usdSpend[index]!.usd, ms: spend.timeSpend[index]!.ms, startedAt: spend.timers.find(timer => timer.turnId === turnId)?.startedAt ?? null }))
    const lookup = snapshot.get(permissionState); same(lookup.policy, permissions.policy); same(lookup.decision("tool.execute", "never-requested"), undefined)
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
      for (const call of calls) {
        apply({ type: "PermissionResolved", action: "tool.execute", requestId: call.callId, decision: { allowed: item.allowed, reason: item.text } }, metadata)
        apply({ type: "PermissionResolved", action: "tool.execute", requestId: call.callId, decision: { allowed: !item.allowed, reason: "changed" } }, metadata)
        apply({ type: "ToolCalled", callId: call.callId, counted: item.allowed }, metadata)
        apply({ type: "ToolReturned", callId: call.callId, version: 1, content: [{ type: "text", text: item.text }], error: null }, metadata)
      }
      apply({ type: "ModelCalled", purpose: "inference", ...model, turnId, callId: inference.callId }, metadata)
      const callId = inference.callId
      apply({ type: "ModelReturned", purpose: "inference", callId, text: item.text, toolCalls: [] }, metadata)
      apply({ type: "TurnSettled", turnId, outcome: "completed", callId }, { recordedAt: index * 100 + 80 })
      const checkpoint = snapshot.checkpoint()!
      same(checkpoint.durable.length, agentDurableAtoms.length)
      if (checkpoint.durable.some(entry => !entry.reference || !Schema.is(Schema.TaggedStruct("DocumentState", { reference: Schema.String }))(entry.state))) throw new Error("Agent checkpoint contains plain state")
      store.transaction(tx => store.commit(tx, { publish: checkpoint.durable.map(entry => ({ owner: entry.name, expected: store.owner(entry.name), document: decodeReference(entry.reference!) })) }))
      log.dispose(); store.discard(); store.collect(); store = open()
      log = createEventLog({ schema: Event, atoms, documents: storedSession(store), checkpoint }); snapshot = log.initial; verify()
    }
  } finally { log.dispose(); store.discard() }
}
function spendStateValue(): ReturnType<typeof reduceSpend> { return { toolSpend: [], tokenSpend: [], usdSpend: [], timeSpend: [], timers: [], turns: [], models: [], tools: [] } }
