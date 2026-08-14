import type { Context } from "effect"
import type { Event, Machine } from "@flamecast/core"
import type { NativeToolSpec } from "./infer"
import { sha256 } from "./sha256"
import type { Projection } from "./projection"

export interface Instruction {
  readonly id: string
  readonly text: string
}

export type NudgePlacement = "tail" | "system"

export interface Nudge {
  readonly id: string
  readonly when: (log: ReadonlyArray<Event>) => boolean
  readonly text: string
  readonly placement?: NudgePlacement
  readonly nativeTools?:
    | ReadonlyArray<NativeToolSpec>
    | ((log: ReadonlyArray<Event>) => ReadonlyArray<NativeToolSpec>)
  readonly withdrawsNativeTools?: ReadonlyArray<string>
}

export const WITHDRAW_ALL = "*"

export interface RenderPlan {
  readonly instructions: ReadonlyArray<Instruction>
  readonly nativeTools: ReadonlyArray<NativeToolSpec>
  readonly nudges: ReadonlyArray<Nudge>
  readonly messageTruncateAt: number
  readonly resultTruncateAt: number
}

export interface ModuleManifest {
  readonly id: string
  readonly version: string
  readonly identity?: unknown
}

export interface AgentProgram<R = never, Services = never> {
  readonly id: string
  readonly parent?: string
  readonly modules: ReadonlyArray<ModuleManifest>
  readonly events: ReadonlyArray<string>
  readonly machines: ReadonlyArray<Machine<R, never>>
  readonly render: RenderPlan
  readonly services: Context.Context<Services>
  readonly projections: Readonly<Record<string, Projection<unknown>>>
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

export const canonicalValue = canonical
