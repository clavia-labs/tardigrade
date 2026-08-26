import type { Ambient, SandboxCallOutcome, SandboxResult } from "@clavia/tardigrade-code/sandbox/service"

export interface SandboxProcessRun {
  readonly type: "run"
  readonly code: string
  readonly names: ReadonlyArray<string>
  readonly packages: Readonly<Record<string, ReadonlyArray<string>>>
  readonly values: Readonly<Record<string, unknown>>
  readonly logCapBytes: number
  readonly ambient?: Ambient
}

export interface SandboxProcessCall {
  readonly type: "call"
  readonly ordinal: number
  readonly packageName: string
  readonly method: string
  readonly args: unknown
}

export type SandboxProcessAnswer = {
  readonly type: "answer"
  readonly ordinal: number
  readonly outcome: SandboxCallOutcome
} | {
  readonly type: "answer"
  readonly ordinal: number
  readonly error: string
}

export interface SandboxProcessSettled {
  readonly type: "settled"
  readonly outcome: SandboxResult
}

export type SandboxProcessInbound = SandboxProcessRun | SandboxProcessAnswer
export type SandboxProcessOutbound = SandboxProcessCall | SandboxProcessSettled
