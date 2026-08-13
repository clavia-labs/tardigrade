import { foldOf, type Envelope } from "@flamecast/core"
import { canonicalValue, type Agent } from "@flamecast/harness"

export interface ProgramObservation {
  readonly request: ReturnType<Agent["request"]>
  readonly machines: ReadonlyArray<{
    readonly id: string
    readonly state: string
    readonly context: unknown
  }>
  readonly dependencies: Readonly<Record<string, unknown>>
}

export const observationOf = <R>(
  agent: Agent<R>,
  log: ReadonlyArray<Envelope>
): ProgramObservation => ({
  request: agent.request(log),
  machines: agent.program.machines.map((machine) => ({
    id: machine.id,
    state: foldOf(machine, log).name,
    context: foldOf(machine, log).context
  })),
  dependencies: Object.fromEntries(
    agent.program.bindings.map((binding) => [
      binding.token.id,
      binding.project(log)
    ])
  )
})

export const modelCallPrefixes = (
  log: ReadonlyArray<Envelope>
): ReadonlyArray<ReadonlyArray<Envelope>> =>
  log.flatMap((event, index) => (event.type === "ModelCalled" ? [log.slice(0, index)] : []))

export const observationallyEquivalent = <Left, Right>(
  left: Agent<Left>,
  right: Agent<Right>,
  logs: ReadonlyArray<ReadonlyArray<Envelope>>
): boolean =>
  logs.every(
    (log) => canonicalValue(observationOf(left, log)) === canonicalValue(observationOf(right, log))
  )
