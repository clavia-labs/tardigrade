import { Clock, Context, Effect } from "effect"
import { EventLog } from "@flamecast/core/event-log"
import { transition, type Reactor } from "@flamecast/core/actor"
import { modelCalled, textReturned, turnFailed } from "./events"
import type { Event } from "@flamecast/core/event"
import type { Action } from "./events"
import { trajectoryOf, turnView } from "@flamecast/code/turns"

// The infer reactor: the model loop, and nothing else. A think is owed when the current turn
// has no unanswered tool call and no terminal; serving marks the attempt, does inference, then
// adds the reaction: the prose as `TextReturned`, the decision as its consequence. While a call
// is unanswered the turn owes nothing here: the tools and code reactors carry it. The pieces
// compose over one log through event names alone.
//
// `ModelCalled` is appended before the inference, so a died attempt leaves its mark. Consecutive
// marks with nothing between them are the crash-loop evidence, and the give-up guard turns three
// of them into the failure terminal instead of a fourth attempt.
const GIVE_UP_AFTER = 3

// REPAIR_AT_MOST bounds schema repairs, separately from the died-attempt guard: a model that
// keeps answering off-schema would repair forever, because each rejected answer is a real tool
// round trip and reads as progress. Two corrections is generous for an encoding mistake; a third
// means the model cannot meet the schema, and a named failure beats an endless turn.
const REPAIR_AT_MOST = 2

// Infer is the model seam: one inference over the trajectory, one action out. The platform binds this to
// a provider. Tests bind it to a stub. `key` is the attempt's identity, the same string the
// `ModelCalled` mark carries: a binding forwards it as the provider's idempotency key where the
// provider takes one, so a retried attempt after a crash collapses server side. A binding with
// no such support ignores it, and the retry stays plain at-least-once.
//
// Contract on the action: a call's callId must be fresh per call, never reused across turns
// (providers mint tool-use ids; a stub must too). A reused id collides with the earlier call's
// recorded pair and the dispatch dedup absorbs the new work.
export class Infer extends Context.Service<
  Infer,
  { readonly react: (trajectory: ReadonlyArray<Event>, key?: string) => Effect.Effect<Action> }
>()("agent/Infer") {}

// consequenceOf returns the action's recorded answer: the model responds by acting. Every
// consequence carries the turn it serves.
const consequenceOf = (action: Action, turn: string, at: number): Event =>
  action.kind === "call"
    ? { type: "ToolCalled", callId: action.callId, name: action.name, arguments: action.arguments, turn, at }
    : action.kind === "complete"
      ? { type: "TurnCompleted", output: action.output, turn, at }
      : { type: "TurnFailed", error: action.error, turn, at }

// diedAttempts counts the `ModelCalled` marks at the end of the turn's slice, with nothing after
// them. Any committed event after a mark is progress and resets the count. Counting inside the
// slice keeps a queued message on the log from masking a crash loop.
const diedAttempts = (turn: ReadonlyArray<Event>): number => {
  let n = 0
  for (let i = turn.length - 1; i >= 0; i--) {
    if (turn[i]!.type === "ModelCalled") n += 1
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

export const inferReactor: Reactor<Infer | EventLog> = (log) => {
  const slice = turnView(log)
  if (slice.length === 0 || awaitingTool(slice) || terminated(slice)) return []
  const head = slice[0] as { id?: unknown }
  const turn = String(head.id)
  // The give-up and repair bounds are derivations, so each derives its own terminal
  // transition: one terminal per turn (tn:<turn>), and a duplicate of either kind absorbs.
  if (diedAttempts(slice) >= GIVE_UP_AFTER) {
    return [
      transition({
        key: `tn:${turn}`,
        input: { turn, error: `the model attempt died ${GIVE_UP_AFTER} times in a row` },
        act: (input) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            return [turnFailed({ error: input.error, turn: input.turn, at })]
          })
      })
    ]
  }
  const rejections = slice.filter((e) => e.type === "ToolCalled" && String((e as { name?: unknown }).name) === "answer").length
  if (rejections > REPAIR_AT_MOST) {
    return [
      transition({
        key: `tn:${turn}`,
        input: { turn, error: `the model's answer did not satisfy the declared schema after ${REPAIR_AT_MOST} corrections` },
        act: (input) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            return [turnFailed({ error: input.error, turn: input.turn, at })]
          })
      })
    ]
  }
  const marks = slice.filter((e) => e.type === "ModelCalled").length
  // The attempt's identity, the same string its ModelCalled mark carries. A died attempt leaves
  // its mark, so the retry subtracts the trailing died marks: retries of one logical attempt
  // share one provider idempotency key, while the marks stay one per run (their repetition is
  // the give-up evidence; the mark's ordinal keys it, so evidence is preserved, not absorbed).
  const attempt = `${turn}/infer/${marks - diedAttempts(slice)}`
  return [
    transition({
      key: `mc:${turn}/${marks}`,
      input: { turn, attempt, ordinal: marks, trajectory: trajectoryOf(log) },
      act: (input) =>
        Effect.gen(function* () {
          const events = yield* EventLog
          const at = yield* Clock.currentTimeMillis
          // The mark records the attempt BEFORE the inference, appended by the act itself: a
          // died attempt leaves its mark, the next derivation counts it, the bound holds.
          // callId is the provider idempotency key (shared across retries of one logical
          // attempt); ordinal is the occurrence the dedup key reads.
          yield* events.append([modelCalled({ callId: input.attempt, ordinal: input.ordinal, turn: input.turn, at })])
          const action = yield* (yield* Infer).react(input.trajectory, input.attempt)
          const after = yield* Clock.currentTimeMillis
          return [
            ...(action.kind === "call" && action.text !== undefined && action.text !== ""
              ? [textReturned({ text: action.text, turn: input.turn, at: after })]
              : []),
            consequenceOf(action, input.turn, after)
          ]
        })
    })
  ]
}
