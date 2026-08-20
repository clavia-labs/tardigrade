import { Cause, Clock, Context, Effect } from "effect"
import { EventLog } from "@clavia/tardigrade-core/event-log"
import { transition, type Reactor } from "@clavia/tardigrade-core/actor"
import { modelCalled, textReturned, turnFailed } from "./events"
import type { Event } from "@clavia/tardigrade-core/event"
import type { Action } from "./events"
import { trajectoryOf, turnEpochOf, turnView } from "@clavia/tardigrade-code/turns"
import type { ContextPolicy } from "./compaction"

// The infer reactor: the model loop, and nothing else. A think is owed when the current turn
// has no unanswered tool call and no terminal; serving marks the attempt, does inference, then
// adds the reaction: the prose as `TextReturned`, the decision as its consequence. While a call
// is unanswered the turn owes nothing here: the tools and code reactors carry it. The pieces
// compose over one log through event names alone.
//
// InferPolicy is the process-crash and schema-repair ceilings. A caller who wants more recovery
// attempts or schema repairs passes an override to inferReactorFor.
export interface InferPolicy {
  readonly giveUpAfter: number
  readonly repairAtMost: number
}

export const DEFAULT_INFER_POLICY: InferPolicy = { giveUpAfter: 3, repairAtMost: 2 }

// InferRequest is one attempt's whole context: the trajectory, and the render the assembly
// derived for it (the system text and the tools the model is offered). The render rides the
// call so the binding holds no opinion about tools; the actor is the render's one owner.
export interface InferRequest {
  readonly trajectory: ReadonlyArray<Event>
  readonly system: string
  readonly tools: ReadonlyArray<import("./request").ToolSpec>
  // What the render truncates and where, stated by the assembly so the binding renders against
  // the same numbers the compaction guard fires on (capability.ts, compactionFor).
  readonly context?: Partial<ContextPolicy>
}

const epochStamp = (epoch: number): { readonly epoch?: number } =>
  epoch === 0 ? {} : { epoch }

// Infer is the model seam: one inference over the request, one action out. The platform binds
// this to a provider. Tests bind it to a stub. `key` is the attempt's identity, the same string
// the `ModelCalled` mark carries: a binding forwards it as the provider's idempotency key where
// the provider takes one, so a retried attempt after a crash collapses server side. A binding
// with no such support ignores it, and the retry stays plain at-least-once.
//
// Contract on the action: a call's callId must be fresh per call, never reused across turns
// (providers mint tool-use ids; a stub must too). A reused id collides with the earlier call's
// recorded pair and the dispatch dedup absorbs the new work.
export class Infer extends Context.Service<
  Infer,
  { readonly react: (request: InferRequest, key?: string) => Effect.Effect<Action> }
>()("agent/Infer") {}

// consequenceOf returns the action's recorded answer: the model responds by acting. Every
// consequence carries the turn it serves and the attempt's spend: `usage` is always stamped,
// and an attempt whose binding reported nothing stamps an empty object, so usageIn reads the
// spend as unknown rather than absent (usage.test.ts, "unknown is sticky").
const consequenceOf = (action: Action, turn: string, epoch: number, attempt: string, at: number): Event => {
  const usage = action.usage ?? {}
  return action.kind === "call"
    ? { type: "ToolCalled", callId: action.callId, name: action.name, arguments: action.arguments, usage, turn, at }
    : action.kind === "complete"
      ? { type: "TurnCompleted", output: action.output, usage, turn, ...epochStamp(epoch), at }
      : {
          type: "TurnFailed",
          error: action.error,
          usage,
          turn,
          ...epochStamp(epoch),
          cause: action.failure?.cause ?? "model",
          ...(action.failure === undefined
            ? {}
            : {
                attempts: action.failure.attempts,
                attemptKey: attempt,
                ...(action.failure.policy === undefined ? {} : { policy: action.failure.policy })
              }),
          at
        }
}

const failureMessage = (cause: Cause.Cause<never>): string => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

// diedAttempts counts the `ModelCalled` marks at the end of the turn's slice, with nothing after
// them. Any committed event after a mark is progress and resets the count. Counting inside the
// slice keeps a queued message on the log from masking a crash loop.
const diedAttempts = (turn: ReadonlyArray<Event>, epoch: number): number => {
  let n = 0
  for (let i = turn.length - 1; i >= 0; i--) {
    const event = turn[i]!
    if (event.type === "ModelCalled" && Number((event as { epoch?: unknown }).epoch ?? 0) === epoch) n += 1
    else break
  }
  return n
}

// awaitingTool reports an unanswered tool call in the turn: the model waits on the world.
const awaitingTool = (slice: ReadonlyArray<Event>): boolean => {
  const answered = new Set(
    slice.filter((e) => e.type === "ToolReturned").map((e) => String((e as { callId?: unknown }).callId))
  )
  return slice.some((e) => e.type === "ToolCalled" && !answered.has(String((e as { callId?: unknown }).callId)))
}

const terminated = (slice: ReadonlyArray<Event>): boolean =>
  slice.some((e) => e.type === "TurnCompleted" || e.type === "TurnFailed")

const terminalKey = (turn: string, epoch: number): string =>
  epoch === 0 ? `tn:${turn}` : `tn:${turn}/${epoch}`

// Render derives what the model is shown over this log: the assembly owns it (capability.ts,
// renderOf).
export type Render = (log: ReadonlyArray<Event>) => {
  readonly system: string
  readonly tools: ReadonlyArray<import("./request").ToolSpec>
  readonly context?: Partial<ContextPolicy>
}

export const inferReactorFor = (policy: Partial<InferPolicy>, render: Render): Reactor<Infer | EventLog> => (log) => {
  const giveUpAfter = policy.giveUpAfter ?? DEFAULT_INFER_POLICY.giveUpAfter
  const repairAtMost = policy.repairAtMost ?? DEFAULT_INFER_POLICY.repairAtMost
  const slice = turnView(log)
  if (slice.length === 0 || awaitingTool(slice) || terminated(slice)) return []
  const head = slice[0] as { id?: unknown }
  const turn = String(head.id)
  const epoch = turnEpochOf(log, turn)
  const died = diedAttempts(slice, epoch)
  const marks = slice.filter((e) => e.type === "ModelCalled").length
  const modelFailures = log.filter(
    (event) =>
      event.type === "TurnFailed" &&
      String((event as { turn?: unknown }).turn) === turn &&
      String((event as { cause?: unknown }).cause) === "model"
  ).length
  const logicalAttempt = slice.filter((e) => e.type === "ToolCalled").length + modelFailures
  const attempt = `${turn}/infer/${logicalAttempt}`
  const effectivePolicy = { giveUpAfter, repairAtMost }
  // The give-up and repair bounds are derivations, so each derives its own terminal
  // transition: one terminal per turn epoch, and a duplicate of either kind absorbs.
  if (died >= giveUpAfter) {
    return [
      transition({
        key: terminalKey(turn, epoch),
        input: { turn, epoch, attempt, attempts: died, policy: effectivePolicy, error: `the model attempt died ${giveUpAfter} times in a row` },
        act: (input) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            return [
              turnFailed({
                error: input.error,
                cause: "inference_attempts_exhausted",
                attempts: input.attempts,
                attemptKey: input.attempt,
                policy: input.policy,
                turn: input.turn,
                ...epochStamp(input.epoch),
                at
              })
            ]
          })
      })
    ]
  }
  const epochStart = slice.findLastIndex(
    (event) => event.type === "TurnResumed" && Number((event as { epoch?: unknown }).epoch) === epoch
  )
  const epochEvents = epochStart === -1 ? slice : slice.slice(epochStart + 1)
  const rejections = epochEvents.filter(
    (event) => event.type === "ToolCalled" && String((event as { name?: unknown }).name) === "answer"
  ).length
  if (rejections > repairAtMost) {
    return [
      transition({
        key: terminalKey(turn, epoch),
        input: {
          turn,
          epoch,
          attempt,
          attempts: rejections,
          policy: effectivePolicy,
          error: `the model's answer did not satisfy the declared schema after ${repairAtMost} corrections`
        },
        act: (input) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            return [
              turnFailed({
                error: input.error,
                cause: "schema_repairs_exhausted",
                attempts: input.attempts,
                attemptKey: input.attempt,
                policy: input.policy,
                turn: input.turn,
                ...epochStamp(input.epoch),
                at
              })
            ]
          })
      })
    ]
  }
  // The attempt's identity, the same string its ModelCalled mark carries. A died attempt leaves
  // its mark. The completed tool calls count logical attempts, so an operator resume keeps the
  // failed inference's provider idempotency key. The mark ordinal remains unique per physical run.
  return [
    transition({
      key: `mc:${turn}/${marks}`,
      input: { turn, epoch, attempt, ordinal: marks, trajectory: trajectoryOf(log), render: render(log), policy: effectivePolicy },
      act: (input) =>
        Effect.gen(function* () {
          const events = yield* EventLog
          const at = yield* Clock.currentTimeMillis
          // The mark records the attempt BEFORE the inference, appended by the act itself: a
          // died attempt leaves its mark, the next derivation counts it, the bound holds.
          // callId is the provider idempotency key (shared across retries of one logical
          // attempt); ordinal is the occurrence the dedup key reads.
          yield* events.append([
            modelCalled({ callId: input.attempt, ordinal: input.ordinal, turn: input.turn, ...epochStamp(input.epoch), at })
          ])
          const action = yield* (yield* Infer)
            .react({ trajectory: input.trajectory, ...input.render }, input.attempt)
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.succeed<Action>({
                      kind: "fail",
                      error: failureMessage(cause),
                      failure: { cause: "inference_error", attempts: 1 }
                    })
              )
            )
          const after = yield* Clock.currentTimeMillis
          return [
            ...(action.kind === "call" && action.text !== undefined && action.text !== ""
              ? [textReturned({ text: action.text, turn: input.turn, at: after })]
              : []),
            consequenceOf(action, input.turn, input.epoch, input.attempt, after)
          ]
        })
    })
  ]
}
