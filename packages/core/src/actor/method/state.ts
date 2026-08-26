// ActorMethodState reports whether an invocation is awaiting its single terminal response or has produced it (tla/communication/Method.tla, AtMostOneResponsePerCall).
export type ActorMethodState<Output> =
  | { readonly status: "pending" }
  | { readonly status: "completed"; readonly output: Output; readonly data?: unknown }
  | { readonly status: "failed"; readonly error: string; readonly data?: unknown }
