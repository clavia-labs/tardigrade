import type { Event } from "@clavia/tardigrade-core/log/event"
import type { Projection } from "@clavia/tardigrade-core/projection"
import { Chunk, HashMap, HashSet, Option } from "effect"
import { modeOf, projectsHistory } from "../output/contract"

// TranscriptProjectionState retains model-visible events and the provisional repair entries that a completion may hide.
export interface TranscriptProjectionState {
  readonly events: Chunk.Chunk<Event>
  readonly hidden: HashSet.HashSet<number>
  readonly members: HashMap.HashMap<string, HashSet.HashSet<number>>
  readonly weights: HashMap.HashMap<number, number>
  readonly projectable: HashMap.HashMap<string, string>
  readonly attemptsByTurn: HashMap.HashMap<string, HashSet.HashSet<string>>
  readonly completedTurns: HashSet.HashSet<string>
  readonly visibleWeight: number
}

// TranscriptProjectionOutput contains the visible history and its additive measure.
export interface TranscriptProjectionOutput {
  readonly events: ReadonlyArray<Event>
  readonly weight: number
}

// TranscriptProjection incrementally maintains model-visible event history.
export type TranscriptProjection = Projection<TranscriptProjectionState, TranscriptProjectionOutput>

const transcriptInitial = (): TranscriptProjectionState => ({
  events: Chunk.empty(),
  hidden: HashSet.empty(),
  members: HashMap.empty(),
  weights: HashMap.empty(),
  projectable: HashMap.empty(),
  attemptsByTurn: HashMap.empty(),
  completedTurns: HashSet.empty(),
  visibleWeight: 0
})

const memberAdded = (
  members: HashMap.HashMap<string, HashSet.HashSet<number>>,
  attempt: string,
  ordinal: number
): HashMap.HashMap<string, HashSet.HashSet<number>> => HashMap.modifyAt(
  members,
  attempt,
  Option.match({
    onNone: () => Option.some(HashSet.make(ordinal)),
    onSome: (ordinals) => Option.some(HashSet.add(ordinals, ordinal))
  })
)

const turnAttemptAdded = (
  attempts: HashMap.HashMap<string, HashSet.HashSet<string>>,
  turn: string,
  attempt: string
): HashMap.HashMap<string, HashSet.HashSet<string>> => HashMap.modifyAt(
  attempts,
  turn,
  Option.match({
    onNone: () => Option.some(HashSet.make(attempt)),
    onSome: (names) => Option.some(HashSet.add(names, attempt))
  })
)

const hideAttempts = (
  state: TranscriptProjectionState,
  attempts: Iterable<string>
): TranscriptProjectionState => {
  let hidden = state.hidden
  let visibleWeight = state.visibleWeight
  for (const attempt of attempts) {
    for (const ordinal of Option.getOrElse(HashMap.get(state.members, attempt), () => HashSet.empty<number>())) {
      if (HashSet.has(hidden, ordinal)) continue
      hidden = HashSet.add(hidden, ordinal)
      visibleWeight -= Option.getOrElse(HashMap.get(state.weights, ordinal), () => 0)
    }
  }
  return { ...state, hidden, visibleWeight }
}

// transcriptProjection constructs the incremental event-log to model-history projection.
export const transcriptProjection = (weightOf: (event: Event) => number = () => 0): TranscriptProjection => ({
  initial: transcriptInitial,
  step: (state, event) => {
    const ordinal = Chunk.size(state.events)
    const weight = weightOf(event)
    const attempt = event.type === "OutputRejected"
      ? String((event as { readonly attempt?: unknown }).attempt ?? "")
      : event.type === "OutputRetryRequested"
        ? String((event as { readonly rejection?: unknown }).rejection ?? "")
        : undefined
    const turn = String((event as { readonly turn?: unknown }).turn ?? "")
    const mode = event.type === "OutputRejected"
      ? modeOf((event as { readonly mode?: unknown }).mode)
      : undefined
    const recordsMember = attempt !== undefined && attempt !== ""
    const members = recordsMember ? memberAdded(state.members, attempt, ordinal) : state.members
    const weights = recordsMember ? HashMap.set(state.weights, ordinal, weight) : state.weights
    const recordsProjection = event.type === "OutputRejected" && attempt !== undefined && attempt !== "" &&
      turn !== "" && mode !== undefined && projectsHistory(mode)
    const projectable = recordsProjection ? HashMap.set(state.projectable, attempt, turn) : state.projectable
    const attemptsByTurn = recordsProjection
      ? turnAttemptAdded(state.attemptsByTurn, turn, attempt)
      : state.attemptsByTurn
    const completedTurns = event.type === "TurnCompleted" && turn !== ""
      ? HashSet.add(state.completedTurns, turn)
      : state.completedTurns
    let next: TranscriptProjectionState = {
      events: Chunk.append(state.events, event),
      hidden: state.hidden,
      members,
      weights,
      projectable,
      attemptsByTurn,
      completedTurns,
      visibleWeight: state.visibleWeight + weight
    }
    if (event.type === "TurnCompleted" && turn !== "") {
      next = hideAttempts(next, Option.getOrElse(HashMap.get(attemptsByTurn, turn), () => HashSet.empty<string>()))
    }
    if (event.type === "OutputRepaired") {
      next = hideAttempts(next, [String((event as { readonly replaced?: unknown }).replaced ?? "")])
    }
    if (attempt !== undefined) {
      const projectedTurn = Option.getOrUndefined(HashMap.get(projectable, attempt))
      if (projectedTurn !== undefined && HashSet.has(completedTurns, projectedTurn)) {
        next = hideAttempts(next, [attempt])
      }
    }
    return next
  },
  output: (state) => ({
    events: Chunk.toReadonlyArray(state.events).filter((_, ordinal) => !HashSet.has(state.hidden, ordinal)),
    weight: state.visibleWeight
  })
})

// projectedOutput replays the transcript projection for complete-history callers.
export const projectedOutput = (events: ReadonlyArray<Event>): ReadonlyArray<Event> => {
  const projection = transcriptProjection()
  return projection.output(events.reduce(projection.step, projection.initial())).events
}
