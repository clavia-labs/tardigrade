import { Cause, Clock, Context, Effect } from "effect"
import { EventLog } from "@clavia/tardigrade-core/event-log"
import { transition, type Reactor } from "@clavia/tardigrade-core/actor"
import { modelCalled, modelResolved, outputRejected, textReturned, turnFailed } from "../events"
import type { Event } from "@clavia/tardigrade-core/event"
import type { Action } from "../events"
import { trajectoryOf, turnEpochOf, turnView } from "@clavia/tardigrade-code/turns"
import {
  asksAgain,
  correctionsOf,
  decodeOutput,
  declaredOutputOf,
  fingerprintOf,
  modeOf,
  mismatchCauseOf,
  recordsRejection,
  type OutputContract,
  type OutputFallback
} from "../output"
import type { ContextPolicy } from "../components/compaction"
import type { ModelCoordinate } from "../model"

// The infer reactor: the model loop, and nothing else. A think is owed when the current turn
// has no unanswered tool call and no terminal; serving marks the attempt, does inference, then
// adds the reaction: the prose as `TextReturned`, the decision as its consequence. While a call
// is unanswered the turn owes nothing here: the tools and code reactors carry it. The pieces
// compose over one log through event names alone.
//
// InferPolicy is the process-crash ceiling. A caller who wants more recovery attempts passes an
// override to inferReactorFor. The bound on corrections of a final response belongs to the
// output implementation the assembly mounts, not here (src/components/repair.ts, RepairPolicy).
export interface InferPolicy {
  readonly giveUpAfter: number
  readonly model?: ModelCoordinate
}

export const DEFAULT_INFER_POLICY: InferPolicy = { giveUpAfter: 3 }

// InferRequest is one attempt's whole context: the trajectory, and the render the assembly
// derived for it (the system text, the tools the model is offered, and the implementation that
// obtains a declared output contract). The render rides the call so the binding holds no opinion
// about tools; the actor is the render's one owner.
export interface InferRequest {
  readonly trajectory: ReadonlyArray<Event>
  readonly model?: ModelCoordinate
  readonly system: string
  readonly tools: ReadonlyArray<import("../request").ToolSpec>
  // What the render truncates and where, stated by the assembly so the binding renders against
  // the same numbers the compaction guard fires on (components/compaction.ts, compaction).
  readonly context?: Partial<ContextPolicy>
  // What the turn does when native structured output is unavailable for this call, and the
  // prompt that fallback needs. Absent means the assembly selected native output.
  readonly output?: { readonly fallback: OutputFallback; readonly system?: string }
}

export interface ModelResolution {
  readonly model: ModelCoordinate
  readonly contextWindowTokens?: number
  readonly maxOutputTokens?: number
  readonly catalogRevision?: string
}

// selectedModelOf applies the visible model-selection order for one turn. A public message may
// replace the model id while the assembly keeps its provider connection. Internal deliveries may
// carry a complete coordinate. Either durable request wins over the assembly default.
export const selectedModelOf = (
  head: Event,
  policy?: ModelCoordinate
): ModelCoordinate | undefined => {
  const selected = (head as { readonly model?: unknown }).model
  const coordinate = (
    typeof selected === "object" &&
    selected !== null &&
    typeof (selected as { readonly provider?: unknown }).provider === "string" &&
    (selected as { readonly provider: string }).provider !== "" &&
    typeof (selected as { readonly model_id?: unknown }).model_id === "string" &&
    (selected as { readonly model_id: string }).model_id !== ""
  )
      ? selected as ModelCoordinate
      : undefined
  const model = typeof selected === "string" && selected.trim().length > 0 && policy !== undefined
    ? { provider: policy.provider, model_id: selected.trim() }
    : undefined
  return coordinate ?? model ?? policy
}

const resolvedModelOf = (events: ReadonlyArray<Event>): ModelCoordinate | undefined => {
  const resolved = events.find((event) => event.type === "ModelResolved") as { readonly model?: unknown } | undefined
  return resolved?.model as ModelCoordinate | undefined
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
  {
    readonly react: (request: InferRequest, key?: string) => Effect.Effect<Action>
    readonly resolve?: (reference: ModelCoordinate) => ModelResolution
  }
>()("agent/Infer") {}

// NativeOutputSupport is compile-time evidence that an injected Infer binding declares native structured output beside tools. nativeOutput carries this requirement into the host type (components/native-output.ts).
export class NativeOutputSupport extends Context.Service<
  NativeOutputSupport,
  { readonly withTools: true }
>()("agent/NativeOutputSupport") {}

// Consequence is what one action is recorded against: the turn and attempt it answers, the
// contract its final response owes, and the implementation that judges a response missing it.
interface Consequence {
  readonly turn: string
  readonly epoch: number
  readonly attempt: string
  readonly at: number
  readonly contract: OutputContract | undefined
}

const stampOf = (action: Action): { readonly endpoint?: unknown } =>
  action.endpoint === undefined ? {} : { endpoint: action.endpoint }

// completionOf judges one `complete` action against the turn's declared contract. An undeclared
// turn ends in prose. A declared one is validated here whatever the provider promised, so a
// strict binding is checked rather than trusted (../turn.test.ts, "a turn that declares an output
// contract"). What a mismatch means belongs to the implementation: a terminal under native or
// local, and a recorded rejection under the two that carry on (src/output.ts, mismatchCauseOf).
const completionOf = (action: Action & { readonly kind: "complete" }, usage: unknown, ctx: Consequence): Event => {
  const mode = action.mode
  const completed = {
    type: "TurnCompleted",
    output: action.output,
    usage,
    attemptKey: ctx.attempt,
    ...(mode === undefined ? {} : { mode }),
    ...stampOf(action),
    turn: ctx.turn,
    ...epochStamp(ctx.epoch),
    at: ctx.at
  } as Event
  if (ctx.contract === undefined) return completed
  // A declared contract is obtained in a mode the binding chose, and every consequence records
  // which. A binding that answers a declared turn without stating one has broken its own
  // contract, and guessing a mode here would put a fact in the log nobody established
  // (Infer above; platform/model/src/output.ts, outputModeOf).
  if (mode === undefined) {
    return {
      type: "TurnFailed",
      error: `the model binding answered a turn declaring "${ctx.contract.name}" without stating the output mode it ran in`,
      usage,
      turn: ctx.turn,
      ...epochStamp(ctx.epoch),
      cause: "inference_error",
      attempts: 1,
      attemptKey: ctx.attempt,
      ...stampOf(action),
      at: ctx.at
    } as Event
  }
  const decoded = decodeOutput(ctx.contract, action.output)
  if (decoded.errors.length === 0) return completed
  if (recordsRejection(mode)) {
    return outputRejected({
      contract: ctx.contract.name,
      fingerprint: fingerprintOf(ctx.contract),
      attempt: ctx.attempt,
      text: action.output,
      errors: decoded.errors,
      mode,
      usage,
      ...stampOf(action),
      turn: ctx.turn,
      ...epochStamp(ctx.epoch),
      at: ctx.at
    })
  }
  const cause = mismatchCauseOf(mode) ?? "output_contract_violation"
  return {
    type: "TurnFailed",
    error:
      `the response missed the declared output contract "${ctx.contract.name}" in ${mode.name} mode:\n` +
      decoded.errors.map((e) => `- ${e}`).join("\n"),
    usage,
    turn: ctx.turn,
    ...epochStamp(ctx.epoch),
    cause,
    attempts: 1,
    attemptKey: ctx.attempt,
    policy: mode,
    ...stampOf(action),
    at: ctx.at
  } as Event
}

// consequenceOf returns the action's recorded answer: the model responds by acting. Every
// consequence carries the turn it serves, the attempt's spend, and who served it: `usage` is
// always stamped, and an attempt whose binding reported nothing stamps an empty object, so
// usageIn reads the spend as unknown rather than absent (usage.test.ts, "unknown is sticky").
// `endpoint` is separate from spend on purpose: an endpoint that reports no tokens still has to
// be named in the log (events.ts, Endpoint).
const consequenceOf = (action: Action, ctx: Consequence): Event => {
  const usage = action.usage ?? {}
  if (action.kind === "call" && ctx.contract !== undefined && action.mode === undefined) {
    return {
      type: "TurnFailed",
      error: `the model binding answered a turn declaring "${ctx.contract.name}" with a tool call but did not state the output mode it ran in`,
      usage,
      turn: ctx.turn,
      ...epochStamp(ctx.epoch),
      cause: "inference_error",
      attempts: 1,
      attemptKey: ctx.attempt,
      ...stampOf(action),
      at: ctx.at
    } as Event
  }
  return action.kind === "call"
    ? ({
        type: "ToolCalled",
        callId: action.callId,
        name: action.name,
        arguments: action.arguments,
        usage,
        ...(action.mode === undefined ? {} : { mode: action.mode }),
        ...stampOf(action),
        turn: ctx.turn,
        at: ctx.at
      } as Event)
    : action.kind === "complete"
      ? completionOf(action, usage, ctx)
      : ({
          type: "TurnFailed",
          error: action.error,
          usage,
          turn: ctx.turn,
          ...epochStamp(ctx.epoch),
          cause: action.failure?.cause ?? "model",
          ...(action.mode === undefined ? {} : { mode: action.mode }),
          ...(action.failure === undefined
            ? {}
            : {
                attempts: action.failure.attempts,
                attemptKey: ctx.attempt,
                ...(action.failure.policy === undefined ? {} : { policy: action.failure.policy })
              }),
          ...stampOf(action),
          at: ctx.at
        } as Event)
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
    else if (event.type === "ModelResolved") continue
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

const rejectionsIn = (events: ReadonlyArray<Event>): ReadonlyArray<Event> =>
  events.filter((event) => event.type === "OutputRejected")

// openRejection returns the rejection this turn still owes an answer to: the last one no
// `OutputRetryRequested` has released. It is what parks a delegated turn, so the component that
// mounted the implementation decides what happens next instead of the reactor asking again by
// itself (src/output.ts, asksAgain).
const openRejection = (events: ReadonlyArray<Event>): Event | undefined => {
  const answered = new Set(
    events
      .filter((e) => e.type === "OutputRetryRequested")
      .map((e) => String((e as { rejection?: unknown }).rejection))
  )
  return rejectionsIn(events)
    .filter((event) => !answered.has(String((event as { attempt?: unknown }).attempt)))
    .at(-1)
}

// Render derives what the model is shown over this log: the assembly owns it (runtime/agent.ts,
// renderOf).
export type Render = (log: ReadonlyArray<Event>) => {
  readonly system: string
  readonly tools: ReadonlyArray<import("../request").ToolSpec>
  readonly context?: Partial<ContextPolicy>
  readonly output?: { readonly fallback: OutputFallback; readonly system?: string }
}

export const inferReactorFor = (policy: Partial<InferPolicy>, render: Render): Reactor<Infer | EventLog> => (log) => {
  const giveUpAfter = policy.giveUpAfter ?? DEFAULT_INFER_POLICY.giveUpAfter
  const slice = turnView(log)
  if (slice.length === 0 || awaitingTool(slice) || terminated(slice)) return []
  const head = slice[0] as Event & { id?: unknown }
  const turn = String(head.id)
  const trajectory = trajectoryOf(log)
  const resolvedModel = resolvedModelOf(slice)
  const model = resolvedModel ?? selectedModelOf(head, policy.model)
  if (model !== undefined && resolvedModel === undefined) {
    return [
      transition({
        key: `mr:${turn}`,
        input: { turn, model },
        act: (input) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            const binding = yield* Infer
            return yield* Effect.try({
              try: () => binding.resolve?.(input.model) ?? { model: input.model },
              catch: (error) => error instanceof Error ? error.message : String(error)
            }).pipe(Effect.match({
              onSuccess: (resolved) => [modelResolved({ turn: input.turn, ...resolved, at })],
              onFailure: (message) => [
                turnFailed({
                  error: message,
                  cause: "inference_error",
                  attempts: 0,
                  attemptKey: `${input.turn}/model`,
                  policy: { model: input.model },
                  turn: input.turn,
                  at
                })
              ]
            }))
          })
      })
    ]
  }
  const epoch = turnEpochOf(log, turn)
  const died = diedAttempts(slice, epoch)
  const marks = slice.filter((e) => e.type === "ModelCalled").length
  const modelFailures = log.filter(
    (event) =>
      event.type === "TurnFailed" &&
      String((event as { turn?: unknown }).turn) === turn &&
      String((event as { cause?: unknown }).cause) === "model"
  ).length
  // A rejected response is a spent logical attempt: the next ask must not reuse the idempotency
  // key, or a deduping provider answers the correction with the response it just refused.
  const rejected = rejectionsIn(slice).length
  const logicalAttempt = slice.filter((e) => e.type === "ToolCalled").length + modelFailures + rejected
  const attempt = `${turn}/infer/${logicalAttempt}`
  const rendered = render(log)
  const fallback = rendered.output?.fallback
  const declared = declaredOutputOf(slice)
  const terminate = (
    input: {
      readonly cause: import("../events").TurnFailureCause
      readonly error: string
      readonly attempts: number
      readonly policy: unknown
    }
  ) => [
    transition({
      key: terminalKey(turn, epoch),
      input: { turn, epoch, attempt, ...input },
      act: (given) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          return [
            turnFailed({
              error: given.error,
              cause: given.cause,
              attempts: given.attempts,
              attemptKey: given.attempt,
              policy: given.policy,
              turn: given.turn,
              ...epochStamp(given.epoch),
              at
            })
          ]
        })
    })
  ]
  // A declaration that is not a contract this repository can serve ends the turn here, before a
  // socket opens. It is the same class the binding reports when an endpoint cannot promise a
  // contract, because both are the turn asking for an output nobody can produce.
  if (declared.kind === "invalid") {
    return terminate({
      cause: "output_unsupported",
      error: `the turn's declared output cannot be served:\n${declared.errors.map((e) => `- ${e}`).join("\n")}`,
      attempts: 0,
      policy: fallback ?? null
    })
  }
  const contract = declared.kind === "contract" ? declared.contract : undefined
  // The give-up and correction bounds are derivations, so each derives its own terminal
  // transition: one terminal per turn epoch, and a duplicate of either kind absorbs.
  if (died >= giveUpAfter) {
    return terminate({
      cause: "inference_attempts_exhausted",
      error: `the model attempt died ${giveUpAfter} times in a row`,
      attempts: died,
      policy: { giveUpAfter }
    })
  }
  const epochStart = slice.findLastIndex(
    (event) => event.type === "TurnResumed" && Number((event as { epoch?: unknown }).epoch) === epoch
  )
  const epochEvents = epochStart === -1 ? slice : slice.slice(epochStart + 1)
  const rejections = rejectionsIn(epochEvents)
  const owed = openRejection(epochEvents)
  if (owed !== undefined) {
    const spent = modeOf((owed as { mode?: unknown }).mode)
    // A rejection with no recorded mode is a log this reactor did not write. Asking again on a
    // policy nobody recorded would be a guess, so the turn ends instead.
    if (spent === undefined) {
      return terminate({
        cause: "output_validation_failed",
        error: "a rejected response carries no recorded output mode, so no correction policy applies to it",
        attempts: rejections.length,
        policy: null
      })
    }
    // A delegated mode parks here. The component that mounted it reads the rejection and decides:
    // its own feedback through `OutputRetryRequested`, its own terminal, or nothing. The reactor
    // never schedules the framework loop on its behalf.
    if (!asksAgain(spent)) return []
    const allowed = correctionsOf(spent)
    if (rejections.length > allowed) {
      return terminate({
        cause: "output_repairs_exhausted",
        error: `the response did not satisfy the declared output contract after ${allowed} correction${allowed === 1 ? "" : "s"}`,
        attempts: rejections.length,
        policy: spent
      })
    }
  }
  // The attempt's identity, the same string its ModelCalled mark carries. A died attempt leaves
  // its mark. The completed tool calls count logical attempts, so an operator resume keeps the
  // failed inference's provider idempotency key. The mark ordinal remains unique per physical run.
  return [
    transition({
      key: `mc:${turn}/${marks}`,
      input: {
        turn,
        epoch,
        attempt,
        ordinal: marks,
        trajectory,
        model,
        render: rendered,
        // The declared policy, stamped on the ask: the contract's identity and the fallback the
        // assembly mounted. The mode the attempt actually ran in is the binding's to report, and
        // it lands on the consequence (events.ts, OutputPolicy; completionOf above).
        stamp:
          contract === undefined
            ? undefined
            : {
                contract: contract.name,
                fingerprint: fingerprintOf(contract),
                ...(fallback === undefined ? {} : { fallback })
              },
        contract
      },
      act: (input) =>
        Effect.gen(function* () {
          const events = yield* EventLog
          const at = yield* Clock.currentTimeMillis
          // The mark records the attempt BEFORE the inference, appended by the act itself: a
          // died attempt leaves its mark, the next derivation counts it, the bound holds.
          // callId is the provider idempotency key (shared across retries of one logical
          // attempt); ordinal is the occurrence the dedup key reads.
          yield* events.append([
            modelCalled({
              callId: input.attempt,
              ...(input.model === undefined ? {} : { model: input.model }),
              ordinal: input.ordinal,
              ...(input.stamp === undefined ? {} : { output: input.stamp }),
              turn: input.turn,
              ...epochStamp(input.epoch),
              at
            })
          ])
          const action = yield* (yield* Infer)
            .react({ trajectory: input.trajectory, ...(input.model === undefined ? {} : { model: input.model }), ...input.render }, input.attempt)
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
            consequenceOf(action, {
              turn: input.turn,
              epoch: input.epoch,
              attempt: input.attempt,
              at: after,
              contract: input.contract
            })
          ]
        })
    })
  ]
}
