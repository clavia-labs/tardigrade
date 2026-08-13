import type { Envelope, Machine } from "@flamecast/core"
import type { ToolSpec } from "./infer"
import { sha256 } from "./sha256"
import type { Announcement, AnySignal, ValueOf } from "./signal"

export interface Instruction {
  readonly id: string
  readonly text: string
}

export type NudgePlacement = "tail" | "system"

export interface Nudge {
  readonly id: string
  readonly when: (log: ReadonlyArray<Envelope>) => boolean
  readonly text: string
  readonly placement?: NudgePlacement
  readonly tools?:
    | ReadonlyArray<ToolSpec>
    | ((log: ReadonlyArray<Envelope>) => ReadonlyArray<ToolSpec>)
  readonly withdraws?: ReadonlyArray<string>
}

export const WITHDRAW_ALL = "*"

export interface RenderPlan {
  readonly instructions: ReadonlyArray<Instruction>
  readonly tools: ReadonlyArray<ToolSpec>
  readonly nudges: ReadonlyArray<Nudge>
  readonly messageTruncateAt: number
  readonly resultTruncateAt: number
}

export interface ModuleManifest {
  readonly id: string
  readonly version: string
  readonly fingerprint?: unknown
}

export interface AgentProgram<R = never> {
  readonly id: string
  readonly parent?: string
  readonly modules: ReadonlyArray<ModuleManifest>
  readonly events: ReadonlyArray<string>
  readonly machines: ReadonlyArray<Machine<R, never>>
  readonly render: RenderPlan
  readonly announcements: ReadonlyArray<Announcement<AnySignal>>
}

const canonical = (value: unknown): string => {
  if (value === null) return "null"
  if (typeof value === "function") return JSON.stringify("[function]")
  if (typeof value === "symbol") return JSON.stringify(String(value))
  if (typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`
}

export const programId = (modules: ReadonlyArray<ModuleManifest>): string =>
  `sha256:${sha256(canonical(modules))}`

export const readSignal = <S extends AnySignal>(
  program: Pick<AgentProgram<never>, "announcements">,
  signal: S,
  log: ReadonlyArray<Envelope>
): ValueOf<S> => {
  const found = program.announcements.find((one) => one.signal.id === signal.id)
  if (found === undefined) throw new Error(`no module announces signal "${signal.id}"`)
  return found.read(log) as ValueOf<S>
}

export const canonicalValue = canonical
