import { Chunk, Clock, Effect } from "effect"
import type { KeyValueStore } from "effect/unstable/persistence"
import { component, withResponse, type ComponentOutput } from "@clavia/tardigrade-core/actor"
import { EventLog } from "@clavia/tardigrade-core/log"
import type { Event } from "@clavia/tardigrade-core/event"
import { bindTransitionContext } from "@clavia/tardigrade-core/transition/transition"
import type { CodeView, PackageDefinition } from "./definition"
import { checkInput, renderSignature } from "../execution/contract"
import { blockedOn, executionKeyOf, executionRefOf, packageKeyOf, packageReturned } from "../execution/events"
import { packageCallPolicyOf, type CallPolicy } from "../execution/policy"
import { eventEpochOf, turnEpochOf, turnHead, turnOf } from "../execution/turns"
import { BARE_SPILL_NOTE, spill, spillPointer, spillPolicyOf } from "../storage/store"

// PackageCall names a proposal and its arguments without exposing executable methods.
export interface PackageCall {
  readonly key: string
  readonly name: string
  readonly arguments: unknown
}

const stampOf = (event: Event) => ({
  callId: String(event.callId),
  ...(event.executionRef === undefined ? {} : { executionRef: executionRefOf(event)! }),
  ...(event.ordinal === undefined ? {} : { ordinal: Number(event.ordinal) }),
  ...(turnOf(event) === undefined ? {} : { turn: turnOf(event)! }),
  ...(event.epoch === undefined ? {} : { epoch: Number(event.epoch) })
})

const eventIdOf = (event: Event): string => String((event as { readonly id?: unknown }).id ?? "")
const servingEvent = (event: Event): boolean => [
  "PackageCalled", "PackageReturned", "CodeSettled", "BlockedOn", "MessageReceived", "ResponseReceived",
  "TurnCompleted", "TurnFailed", "TurnCancelled", "TurnResumed"
].includes(event.type)

// packageCalls owns method execution and responses at the committed request boundary (packages/agent/integration/package-permissions.test.ts).
export const packageCalls = <R>(definition: PackageDefinition<R>) => component({
  name: `package.${definition.name}`,
  initial: () => Chunk.empty<Event>(),
  step: (state, event) => {
    if (event.type === "TurnCompleted" || event.type === "TurnCancelled") {
      const turn = turnOf(event)
      if (turn === undefined) return state
      const log = Chunk.toReadonlyArray(state)
      const epoch = eventEpochOf(event)
      const failed = log.some(item => item.type === "TurnFailed" && turnOf(item) === turn && eventEpochOf(item) === epoch)
      if (failed || epoch !== turnEpochOf(log, turn)) return Chunk.append(state, event)
      const retained = [...state].filter(item => turnOf(item) !== turn && !(item.type === "MessageReceived" && eventIdOf(item) === turn))
      return retained.length === state.length ? state : Chunk.fromIterable(retained)
    }
    if (!servingEvent(event) || event.type === "PackageCalled" && !String(event.name).startsWith(`${definition.name}.`)) return state
    return Chunk.append(state, event)
  },
  output: (state): ComponentOutput<CodeView, R | KeyValueStore.KeyValueStore, unknown> => {
    const log = Chunk.toReadonlyArray(state)
    const returned = new Set(log.filter(event => event.type === "PackageReturned").map(packageKeyOf))
    const requests = log.filter(event => event.type === "PackageCalled" && String(event.name).startsWith(`${definition.name}.`))
    const head = turnHead(log)
    const current = requests.filter(event => turnOf(event) === (head === undefined ? undefined : String(head.id)))
    const pending = requests.filter(event => {
      if (returned.has(packageKeyOf(event))) return false
      if (log.some(end => end.type === "CodeSettled" && executionKeyOf(end) === executionKeyOf(event) && event.executionRef !== undefined)) return false
      if (turnOf(event) !== undefined && log.some(end => ["TurnCompleted", "TurnFailed", "TurnCancelled"].includes(end.type) && turnOf(end) === turnOf(event) && eventEpochOf(end) === eventEpochOf(event))) return false
      const blocked = log.find(item => item.type === "BlockedOn" && packageKeyOf(item) === packageKeyOf(event))
      return blocked === undefined || log.some(reply => ["MessageReceived", "ResponseReceived"].includes(reply.type) && reply.id === blocked.awaiting)
    })
    const callView = (event: Event): PackageCall => ({
      key: bindTransitionContext(event, `package.${definition.name}`).intent("invoke", []).key,
      name: String(event.name),
      arguments: event.arguments
    })
    return {
      view: {
        packages: [{ name: definition.name, description: definition.description, methods: Object.keys(definition.methods), ...(definition.docs === undefined ? {} : { docs: definition.docs }), ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }) }],
        calls: current.map(callView),
        pendingCalls: pending.map(callView)
      },
      transitions: pending.map(event => {
        const context = bindTransitionContext(event, `package.${definition.name}`)
        const stamp = stampOf(event)
        const invocation = turnOf(event) === undefined ? {} : { invocation: { method: "message", id: turnOf(event)!, epoch: eventEpochOf(event) } }
        const respond = (result: unknown) => context.intent("invoke", at => packageReturned({ ...stamp, result, at }), invocation)
        return withResponse(context.effect("invoke", {
          ...invocation,
          concurrent: true,
          input: event,
          act: () => Effect.gen(function* () {
            const method = String(event.name).slice(definition.name.length + 1)
            const fn = definition.methods[method]
            const recorded = event.policy as CallPolicy | undefined
            const callPolicy = packageCallPolicyOf(recorded?.call)
            const spillPolicy = spillPolicyOf(recorded === undefined ? { note: BARE_SPILL_NOTE } : { ...recorded.spill, note: () => recorded.spill.note })
            const annotations = definition.annotations?.[method]
            const shadow = recorded?.shadow ?? (turnHead(log)?.shadow === true)
            const input = definition.docs?.[method]?.input
            const issues = input === undefined ? [] : checkInput(event.arguments, input)
            const error = fn === undefined ? `Unknown method ${String(event.name)}`
              : shadow && annotations?.readOnlyHint !== true && annotations?.openWorldHint !== false
                ? `shadow run: ${String(event.name)} is an open-world write and does not execute in a shadow run`
                : issues.length === 0 ? undefined : `${String(event.name)}: ${issues.join("; ")}. Signature: ${renderSignature(method, input)}`
            type Outcome = { readonly parked: true; readonly awaiting?: string } | { readonly parked: false; readonly result: unknown }
            const invoke = (attempt: number): Effect.Effect<Outcome, never, R> => {
              const fail = (reason: string): Effect.Effect<Outcome, never, R> => {
                const delay = callPolicy.retryDelaysMs[attempt]
                return delay === undefined
                  ? Effect.succeed({ parked: false, result: { error: `${String(event.name)} failed after ${attempt + 1} attempts: ${reason}`, attempts: attempt + 1, policy: callPolicy } })
                  : Effect.sleep(delay).pipe(Effect.andThen(invoke(attempt + 1)))
              }
              return Effect.suspend(() => fn!(event.arguments, { callId: stamp.callId })).pipe(
                Effect.timeout(callPolicy.attemptTimeoutMs),
                Effect.map((result): Outcome => ({ parked: false, result })),
                Effect.catchTags({ Park: park => Effect.succeed({ parked: true as const, ...(park.awaiting === undefined ? {} : { awaiting: park.awaiting }) }), TimeoutError: () => fail(`timed out after ${callPolicy.attemptTimeoutMs}ms`) }),
                Effect.catchDefect(defect => fail(defect instanceof Error ? defect.message : String(defect)))
              )
            }
            const outcome: Outcome = error === undefined ? yield* invoke(0) : { parked: false, result: { error } }
            const at = yield* Clock.currentTimeMillis
            if (outcome.parked) {
              if (outcome.awaiting !== undefined) {
                const events = yield* EventLog
                yield* events.append([blockedOn({ ...stamp, awaiting: outcome.awaiting, at })])
              }
              return []
            }
            const json = JSON.stringify(outcome.result ?? null)
            if (json.length > spillPolicy.spillBytes) {
              const key = packageKeyOf(event)
              yield* Effect.orDie(spill(key, json))
              return [packageReturned({ ...stamp, ...spillPointer(key, json.length, json.slice(0, spillPolicy.previewChars), spillPolicy.note), at })]
            }
            return [packageReturned({ ...stamp, result: outcome.result, at })]
          })
        }), respond)
      })
    }
  }
})
