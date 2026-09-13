import { upcastError } from "../log/upcast"
import { hasUnansweredToolCall, responsesOf } from "../log/response"
import { bindTransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { eventAt, eventPositionOf } from "@clavia/tardigrade-core/event"
import { RetrySchedule, retryDelayOf } from "./retry"
import { LanguageModel } from "effect/unstable/ai"
import { react } from "./model/index"
import { unknownModelError } from "./error"
import { BindingSettings, ModelSelection } from "./model/settings"
import { Cause, Clock, Effect, Random, Schema } from "effect"
import { EventLog } from "@clavia/tardigrade-core/log"
import { HashMap, Option } from "effect"
import { Self } from "@clavia/tardigrade-core/runtime"
import { transitionProjection, type CompleteTransitionDerivation, type TransitionProjection } from "@clavia/tardigrade-core/transition"
import { modelCalled, modelReturned, outputRejected, outputRepaired, textReturned, turnFailed } from "../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { Machine } from "@clavia/tardigrade-core/machine"
import type { Action } from "../log/events"
import { trajectoryOf, turnEpochOf, turnView } from "@clavia/tardigrade-code/execution/turns"
import {
  initialTurnProjection,
  reduceTurnProjection,
  trajectoryFrom,
  turnEpochFrom,
  turnViewFrom,
  type TurnProjectionState
} from "@clavia/tardigrade-code/execution/turn-projection"
import {
  asksAgain,
  correctionsOf,
  decodeOutput,
  declaredOutputOf,
  fingerprintOf,
  modeOf,
  mismatchCauseOf,
  projectsHistory,
  recordsRejection,
  type OutputContract
} from "../output/contract"
import { modelRefOf, type ModelRef } from "./reference"
import {
  applyModelPolicy,
  DEFAULT_MODEL_POLICY,
  modelAllowedBy,
  modelPolicyOf,
  type ModelPolicy
} from "./access"
import {
  DEFAULT_INFER_POLICY,
  type InferPolicy,
  type ModelResolution,
  type Render
} from "./contract"

// The inference machine derives a model attempt when the current turn has no unanswered tool call or terminal.
// selectedModelOf applies the visible model-selection order for one turn (runtime/composition.test.ts, "the actor owns model selection").
export const selectedModelOf = (head: Event, policy?: ModelRef): ModelRef | undefined => {
  const selected = (head as { readonly model?: unknown }).model
  return selected === undefined ? policy : modelRefOf(selected)
}

class ModelSelectionError extends Error {}

const resolvedModelFor = (
  resolve: ((reference?: ModelRef) => ModelResolution) | undefined,
  reference: ModelRef | undefined,
  models: ModelPolicy,
  policyError: string | undefined
): ModelRef => {
  if (policyError !== undefined) throw new ModelSelectionError(policyError)
  if (reference !== undefined && !modelAllowedBy(models, reference)) {
    throw new ModelSelectionError(`model ${reference.provider}/${reference.model_id} is excluded by the effective model policy`)
  }
  const resolved = resolve?.(reference)
  if (resolved === undefined) {
    if (reference === undefined) {
      throw new ModelSelectionError("no model was selected; supply { provider, model_id } or configure a default")
    }
    return reference
  }
  const allowed = applyModelPolicy(resolved.models ?? DEFAULT_MODEL_POLICY, models)
  if (!modelAllowedBy(allowed, resolved.model)) {
    throw new ModelSelectionError(`model ${resolved.model.provider}/${resolved.model.model_id} is excluded by the effective model policy`)
  }
  return resolved.model
}

const epochStamp = (epoch: number): { readonly epoch?: number } =>
  epoch === 0 ? {} : { epoch }

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
// local, and a recorded rejection under the two that carry on (src/output/contract.ts, mismatchCauseOf).
const completionOf = (action: Action & { readonly kind: "complete" }, ctx: Consequence): Event => {
  const mode = action.mode
  const completed = {
    type: "TurnCompleted",
    output: action.output,
    attemptKey: ctx.attempt,
    ...(mode === undefined ? {} : { mode }),
    ...stampOf(action),
    turn: ctx.turn,
    ...epochStamp(ctx.epoch),
    at: ctx.at
  } as Event
  if (ctx.contract === undefined) return completed
  // mode identifies the binding's output contract enforcement (binding/output.ts, outputModeOf).
  if (mode === undefined) {
    return {
      type: "TurnFailed",
      error: { message: `the model binding answered a turn declaring "${ctx.contract.name}" without stating the output mode it ran in` },
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
      ...stampOf(action),
      turn: ctx.turn,
      ...epochStamp(ctx.epoch),
      at: ctx.at
    })
  }
  const cause = mismatchCauseOf(mode) ?? "output_contract_violation"
  return {
    type: "TurnFailed",
    error: { message:
      `the response missed the declared output contract "${ctx.contract.name}" in ${mode.name} mode:\n` +
      decoded.errors.map((e) => `- ${e}`).join("\n") },
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

// consequencesOf records each tool request separately under its model response (runtime/batches.test.ts).
const consequencesOf = (action: Action, ctx: Consequence): ReadonlyArray<Event> => {
  if (action.kind === "complete") return [completionOf(action, ctx)]
  const stamp = {
    turn: ctx.turn,
    ...epochStamp(ctx.epoch),
    ...(action.mode === undefined ? {} : { mode: action.mode }),
    ...stampOf(action),
    at: ctx.at
  }
  if (action.kind === "fail") return [{
    ...stamp,
    type: "TurnFailed",
    error: upcastError(action.error),
    cause: action.failure?.cause ?? "model",
    attemptKey: ctx.attempt,
    ...(action.failure === undefined ? {} : { attempts: action.failure.attempts, policy: action.failure.policy })
  }]
  if (ctx.contract !== undefined && action.mode === undefined) return [{
    ...stamp,
    type: "TurnFailed",
    error: { message: `the model binding answered a turn declaring "${ctx.contract.name}" with a tool call but did not state the output mode it ran in` },
    cause: "inference_error",
    attempts: 1,
    attemptKey: ctx.attempt
  }]
  return action.calls.flatMap(({ validationError, ...call }) => [
    { type: "ToolCalled", ...call, ...stamp, responseId: ctx.attempt },
    ...(validationError === undefined ? [] : [{ type: "ToolReturned", callId: call.callId, result: { error: validationError }, isFailure: true, ...stamp }])
  ])
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

const terminated = (slice: ReadonlyArray<Event>): boolean =>
  slice.some((e) => e.type === "TurnCompleted" || e.type === "TurnFailed" || e.type === "TurnCancelled")

const rejectionsIn = (events: ReadonlyArray<Event>): ReadonlyArray<Event> =>
  events.filter((event) => event.type === "OutputRejected")

// openRejection returns the rejection this turn still owes an answer to: the last one no
// `OutputRetryRequested` has released. It is what parks a delegated turn, so the component that
// mounted the implementation decides what happens next instead of the reactor asking again by
// itself (src/output/contract.ts, asksAgain).
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

// Render derives what the model is shown over this log: the assembly owns it (runtime/composition.ts,
// renderOf).
interface InferDerivation {
  readonly slice: ReadonlyArray<Event>
  readonly epoch: number
  readonly trajectory: () => ReadonlyArray<Event>
  readonly modelFailures: number
  readonly rendered: ReturnType<Render>
  readonly renderAfter: (event: Event) => ReturnType<Render>
}

const inferTransitionsFor = (policy: Partial<InferPolicy>, derived: InferDerivation): ReadonlyArray<import("@clavia/tardigrade-core/runtime").Transition<never, LanguageModel.LanguageModel | EventLog | Self>> => {
  const giveUpAfter = policy.giveUpAfter ?? DEFAULT_INFER_POLICY.giveUpAfter
  const slice = derived.slice
  if (slice.length === 0 || hasUnansweredToolCall(slice) || terminated(slice)) return []
  const context = bindTransitionContext(slice[slice.length - 1]!, "infer")
  const head = slice[0] as Event & { id?: unknown }
  const turn = String(head.id)
  const epoch = derived.epoch
  const inheritedModels = modelPolicyOf((head as { readonly models?: unknown }).models)
  let policyError: string | undefined
  let models = inheritedModels
  try {
    models = applyModelPolicy(inheritedModels, policy.models ?? DEFAULT_INFER_POLICY.models)
  } catch (error) {
    policyError = error instanceof Error ? error.message : String(error)
  }
  const died = diedAttempts(slice, epoch)
  const latestResponse = slice.findLast((event) => event.type === "ModelReturned" && Number(event.epoch ?? 0) === epoch)
  const pendingRetry = latestResponse !== undefined && Schema.is(RetrySchedule)(latestResponse.retry) ? latestResponse.retry : undefined
  const lastMark = slice.findLast((event) => event.type === "ModelCalled" && Number(event.epoch ?? 0) === epoch)
  const model = ((died > 0 || pendingRetry !== undefined) ? modelRefOf(lastMark?.model) : undefined) ?? selectedModelOf(head, models.default)
  const marks = slice.filter((e) => e.type === "ModelCalled").length
  const modelFailures = derived.modelFailures
  // A rejected response is a spent logical attempt: the next ask must not reuse the idempotency
  // key, or a deduping provider answers the correction with the response it just refused.
  const logicalAttempt = Math.max(
    slice.filter((event) => event.type === "ModelReturned").length,
    responsesOf(slice).returnedAttempts + modelFailures + slice.filter((event) => event.type === "ModelReturned" && event.retry !== undefined).length
  )
  const attempt = `${turn}/infer/${logicalAttempt}`
  const rendered = derived.rendered
  const fallback = rendered.output?.fallback
  const declared = declaredOutputOf(slice)
  const terminate = (
    input: {
      readonly cause: import("../log/events").TurnFailureCause
      readonly error: string
      readonly attempts: number
      readonly policy: unknown
    }
  ) => [
    context.intent("fail", (at) => turnFailed({
      ...input, attemptKey: attempt, turn, ...epochStamp(epoch), at
    }), { invocation: { method: "message", id: turn, epoch } })
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
  // attempt advances after a recorded response and survives an unanswered crash (inference/retry.test.ts).
  return [
    context.effect("infer", {
      invocation: { method: "message", id: turn, epoch },
      input: {
        turn,
        epoch,
        attempt,
        ordinal: marks,
        retryIndex: pendingRetry?.index ?? (died > 0 ? Number(lastMark?.retryIndex ?? 0) : 0),
        dueAt: pendingRetry?.dueAt,
        trajectory: derived.trajectory,
        model,
        models,
        policyError,
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
      act: (input, { signal }) =>
        Effect.gen(function* () {
          const events = yield* EventLog
          const self = yield* Self
          if (input.dueAt !== undefined) {
            const now = yield* Clock.currentTimeMillis
            if (input.dueAt > now) yield* Effect.sleep(input.dueAt - now)
          }
          const at = yield* Clock.currentTimeMillis
          const registry = yield* ModelSelection
          const selection = yield* Effect.try({
            try: () => resolvedModelFor(registry.resolve, input.model, input.models, input.policyError),
            catch: (error) => ({
              message: error instanceof Error ? error.message : String(error),
              cause: error instanceof ModelSelectionError ? "model_selection" as const : "inference_error" as const
            })
          }).pipe(Effect.match({
            onFailure: (failure) => ({ failure }),
            onSuccess: (selected) => ({ selected })
          }))
          if ("failure" in selection) {
            return [
              turnFailed({
                error: selection.failure.message,
                cause: selection.failure.cause,
                attempts: 0,
                attemptKey: `${input.turn}/model`,
                policy: input.model === undefined ? null : { model: input.model },
                turn: input.turn,
                ...epochStamp(input.epoch),
                at
              })
            ]
          }
          const selected = selection.selected
          const settings = yield* (registry.settings?.(selected) ?? BindingSettings)
          const requestPolicy = settings.policy
          const pricing = settings.pricing
          // The mark records the attempt BEFORE the inference, appended by the act itself: a
          // died attempt leaves its mark, the next derivation counts it, the bound holds.
          // callId is reused after a crash with no recorded response; a recorded failure
          // schedules a fresh key (retry.test.ts). Ordinal identifies the physical run.
          const mark = modelCalled({
            callId: input.attempt,
            model: selected,
            ordinal: input.ordinal,
            retryIndex: input.retryIndex,
            ...(pricing === undefined ? {} : { pricing }),
            ...(input.stamp === undefined ? {} : { output: input.stamp }),
            turn: input.turn,
            ...epochStamp(input.epoch),
            at
          })
          yield* events.append([mark])
          const actualRender = derived.renderAfter(mark)
          const trajectory = input.trajectory()
          let partialOutput = ""
          let partialPersisted = false
          const persistPartialOutput = () => {
            if (partialOutput === "" || partialPersisted) return Effect.void
            partialPersisted = true
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((at) => events.append([textReturned({
                text: partialOutput, turn: input.turn, ...epochStamp(input.epoch), at
              })])),
              Effect.asVoid
            )
          }
          const action = yield* react(
              {
                trajectory,
                identity: { ...self, turn: input.turn },
                model: selected,
                ...actualRender
              },
              input.attempt,
              signal,
              (delta) => {
                if (delta.kind !== "reasoning") partialOutput += delta.text
              }
            )
            .pipe(
              Effect.provideService(BindingSettings, settings),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.succeed<Action>({
                      kind: "fail",
                      error: unknownModelError(Cause.squash(cause)),
                      failure: { cause: "inference_error", attempts: 1 }
                    })
              ),
              Effect.onInterrupt(persistPartialOutput),
              // Abort can settle the provider before interruption; both paths share the persistence guard (index.test.ts).
              Effect.ensuring(
                Effect.suspend(() => signal?.aborted === true ? persistPartialOutput() : Effect.void)
              )
            )
          const after = yield* Clock.currentTimeMillis
          const calls = action.kind === "calls" ? action.calls : []
          const seen = new Set(trajectory.filter((event) => event.type === "ToolCalled" && event.turn === input.turn).map((event) => String(event.callId)))
          const duplicate = calls.find((call) => {
            if (seen.has(call.callId)) return true
            seen.add(call.callId)
            return false
          })
          const invalid = action.kind === "calls" && calls.length === 0
          const checked: Action = duplicate !== undefined || invalid ? {
            kind: "fail", error: duplicate === undefined ? "the model returned an empty tool batch" : `duplicate tool call ID ${JSON.stringify(duplicate.callId)} within turn ${JSON.stringify(input.turn)}`,
            ...(action.usage === undefined ? {} : { usage: action.usage }),
            ...(action.endpoint === undefined ? {} : { endpoint: action.endpoint }),
            failure: { cause: "inference_error", attempts: 1 }
          } : action
          const delay = checked.kind === "fail" && checked.retryable === true && requestPolicy !== undefined
            ? retryDelayOf(requestPolicy, input.retryIndex, checked.retryAfterMs, yield* Random.next)
            : undefined
          const retry = delay === undefined ? undefined : { dueAt: after + delay, index: input.retryIndex + 1 }
          const consequences = retry === undefined ? consequencesOf(checked, {
            turn: input.turn,
            epoch: input.epoch,
            attempt: input.attempt,
            at: after,
            contract: input.contract
          }) : []
          const repaired = consequences.some((event) => event.type === "TurnCompleted")
            ? trajectory.filter((event) => {
                if (event.type !== "OutputRejected") return false
                const value = event as { readonly turn?: unknown; readonly epoch?: unknown; readonly mode?: unknown }
                const mode = modeOf(value.mode)
                return String(value.turn ?? "") === input.turn &&
                  Number(value.epoch ?? 0) === input.epoch &&
                  mode !== undefined &&
                  projectsHistory(mode)
              })
            : []
          return [
            modelReturned({
              callId: input.attempt, ordinal: input.ordinal, turn: input.turn, ...epochStamp(input.epoch),
              outcome: action.kind === "fail" ? "failed" : "returned",
              ...(retry === undefined ? {} : { retry }),
              usage: action.usage ?? {}, ...stampOf(action),
              ...(action.reasoning === undefined ? {} : { reasoning: action.reasoning }),
              ...(action.continuation === undefined ? {} : { continuation: action.continuation }),
              ...(action.response === undefined ? {} : { response: action.response }),
              ...(action.finish === undefined ? {} : { finish: action.finish }),
              ...(action.reportedCostUsd === undefined ? {} : { reportedCostUsd: action.reportedCostUsd }),
              ...(action.kind === "fail" ? { error: action.error, ...(action.text === undefined ? {} : { text: action.text }) } : {}), at: after
            }),
            ...(action.kind === "calls" && action.text !== undefined && action.text !== ""
              ? [textReturned({ text: action.text, turn: input.turn, at: after })]
              : []),
            ...repaired.map((event) => outputRepaired({
              replaced: String((event as { readonly attempt?: unknown }).attempt ?? ""),
              replacement: input.attempt,
              turn: input.turn,
              ...epochStamp(input.epoch),
              at: after
            })),
            ...consequences
          ]
        })
    })
  ]
}

// inferenceFromHistory derives inference through complete replay.
export const inferenceFromHistory = (policy: Partial<InferPolicy>, render: Render): CompleteTransitionDerivation<LanguageModel.LanguageModel | EventLog | Self> => (history) => {
  const log = history.map((event, index) => eventPositionOf(event) === undefined ? eventAt(event, index + 1) : event)
  const slice = turnView(log)
  const turn = String((slice[0] as { readonly id?: unknown } | undefined)?.id ?? "")
  return inferTransitionsFor(policy, {
    slice,
    epoch: turnEpochOf(log, turn),
    trajectory: () => trajectoryOf(log),
    modelFailures: log.filter(
      (event) =>
        event.type === "TurnFailed" &&
        String((event as { readonly turn?: unknown }).turn) === turn &&
        String((event as { readonly cause?: unknown }).cause) === "model"
    ).length,
    rendered: render(log),
    renderAfter: (event) => render([...log, event])
  })
}

export type InferenceMachineProjection<State> = Machine<Event, State, ReturnType<Render>>

interface IncrementalInferState<State> {
  readonly turns: TurnProjectionState
  readonly render: State
  readonly modelFailures: HashMap.HashMap<string, number>
}

// inferenceMachine derives inference from the behavioral product of turn and render state.
export const inferenceMachine = <State>(
  policy: Partial<InferPolicy>,
  projection: InferenceMachineProjection<State>
): TransitionProjection<IncrementalInferState<State>, LanguageModel.LanguageModel | EventLog | Self> => transitionProjection({
  initial: () => ({
    turns: initialTurnProjection(),
    render: projection.initial(),
    modelFailures: HashMap.empty()
  }),
  step: (state, event) => {
    const turn = String((event as { readonly turn?: unknown }).turn ?? "")
    const failed = event.type === "TurnFailed" && String((event as { readonly cause?: unknown }).cause) === "model"
    const count = Option.getOrElse(HashMap.get(state.modelFailures, turn), () => 0)
    return {
      turns: reduceTurnProjection(state.turns, event),
      render: projection.step(state.render, event),
      modelFailures: failed ? HashMap.set(state.modelFailures, turn, count + 1) : state.modelFailures
    }
  },
  output: (state) => {
    const slice = turnViewFrom(state.turns)
    const turn = String((slice[0] as { readonly id?: unknown } | undefined)?.id ?? "")
    return inferTransitionsFor(policy, {
      slice,
      epoch: turnEpochFrom(state.turns, turn),
      trajectory: () => trajectoryFrom(state.turns),
      modelFailures: Option.getOrElse(HashMap.get(state.modelFailures, turn), () => 0),
      rendered: projection.output(state.render),
      renderAfter: (event) => projection.output(projection.step(state.render, event))
    })
  }
})
