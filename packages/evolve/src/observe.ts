import { foldOf, type Event } from "@flamecast/core"
import { canonicalValue, type Agent } from "@flamecast/harness"

export interface ProgramObservation {
  readonly request: ReturnType<Agent["request"]>
  readonly machines: ReadonlyArray<{
    readonly id: string
    readonly state: string
    readonly context: unknown
  }>
  readonly projections: Readonly<Record<string, unknown>>
}

export const observationOf = <R>(
  agent: Agent<R>,
  log: ReadonlyArray<Event>
): ProgramObservation => ({
  request: agent.request(log),
  machines: agent.definition.machines.map((machine) => ({
    id: machine.id,
    state: foldOf(machine, log).name,
    context: foldOf(machine, log).context
  })),
  projections: Object.fromEntries(
    Object.entries(agent.definition.projections).map(([id, project]) => [id, project(log)])
  )
})

export const modelCallPrefixes = (
  log: ReadonlyArray<Event>
): ReadonlyArray<ReadonlyArray<Event>> =>
  log.flatMap((event, index) => (event.type === "ModelCalled" ? [log.slice(0, index)] : []))

export const observationallyEquivalent = <Left, Right>(
  left: Agent<Left>,
  right: Agent<Right>,
  logs: ReadonlyArray<ReadonlyArray<Event>>
): boolean =>
  logs.every(
    (log) => canonicalValue(observationOf(left, log)) === canonicalValue(observationOf(right, log))
  )
