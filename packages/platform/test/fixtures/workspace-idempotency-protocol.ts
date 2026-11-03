export type Fault = "none" | "claimFailure" | "afterClaim" | "beforeComplete" | "afterComplete"
export type Mutation =
  | { readonly method: "append"; readonly value: number }
  | { readonly method: "write"; readonly content: string }
  | { readonly method: "edit"; readonly oldText: string; readonly newText: string }
  | { readonly method: "invalid" }

export type Request =
  | { readonly type: "call"; readonly workspace: number; readonly key: string; readonly mutation: Mutation; readonly fault: Fault; readonly copies: number }
  | { readonly type: "snapshot" }

export type Outcome =
  | { readonly status: "success"; readonly value: string | null }
  | { readonly status: "error"; readonly reason: "pending" | "conflict" | "unsupported" | "terminal" | "storage"; readonly message: string }

export interface Snapshot {
  readonly rows: readonly { readonly workspace_id: string; readonly caller_key: string; readonly input_digest: string; readonly outcome: string | null }[]
  readonly logs: readonly string[]
  readonly files: readonly (string | null)[]
  readonly outside: string | null
}

export type Response =
  | { readonly type: "ready" }
  | { readonly type: "boundary"; readonly fault: Fault; readonly outcomes?: readonly Outcome[] }
  | { readonly type: "result"; readonly outcomes: readonly Outcome[] }
  | { readonly type: "snapshot"; readonly snapshot: Snapshot }
  | { readonly type: "fatal"; readonly message: string }
