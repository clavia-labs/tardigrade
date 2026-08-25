// ActorMethodState reports what an actor's log says about an invocation that exists. revision identifies a reportable blocked state, and sequence orders that state on the caller's response stream.
export type ActorMethodState<Output> =
  | { readonly status: "pending" }
  | {
      readonly status: "blocked"
      readonly reason: string
      readonly revision?: string
      readonly sequence?: number
      readonly data?: unknown
    }
  | { readonly status: "completed"; readonly output: Output; readonly sequence?: number; readonly data?: unknown }
  | { readonly status: "failed"; readonly error: string; readonly sequence?: number; readonly data?: unknown }
