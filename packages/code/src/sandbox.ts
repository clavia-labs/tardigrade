import { Context, Effect } from "effect"

// SandboxResult is what one execution settles to: the body's return value, or why it threw. A
// thrown body is a value here, and the model or the run reactor reads it. Only the machinery's
// own death escapes.
// `logs` is the body's captured console output, capped by the sandbox; a silent body carries
// none. It exists because a model's print-to-inspect habit otherwise reads as a null result
// (TODO.md item 8, the run-950bda60-e05 grounding autopsy).
export interface SandboxResult {
  readonly result?: unknown
  readonly error?: string
  readonly logs?: ReadonlyArray<string>
}

// Bindings is what a code body sees in scope: one object per package, one async function per
// method. The functions are host-side proxies; the sandbox only wires names into scope. A
// binding is a package proxy (an object of methods) or a plain value spliced into scope
// (`brief`, `spec`, `trajectory`).
export type Bindings = Readonly<Record<string, Readonly<Record<string, (args: unknown) => Promise<unknown>>> | unknown>>

// Ambient pins one execution's clock and randomness to recorded data, so every attempt sees
// the same values. `at` is the dispatch event's own timestamp (a body is a pure function of
// the log, so its "now" IS its dispatch's instant); `seed` is the execId. Nothing new needs
// recording because the dispatch event already carries the value.
export interface Ambient {
  readonly at: number
  readonly seed: string
}

// Sandbox is the seam that runs one code body with the bindings in scope. The platform binds an isolate;
// tests bind a plain async function constructor. Code must be deterministic between package
// calls: replay re-runs the body from the top and depends on it taking the same path to each
// call. The clock and the random source are ambient-shimmed rather than banned (a model's
// priors reach for both): Date.now, the no-argument Date constructor, and Math.random answer
// from `ambient`, identically on every attempt.
export class Sandbox extends Context.Service<
  Sandbox,
  {
    readonly run: (code: string, bindings: Bindings, ambient?: Ambient) => Effect.Effect<SandboxResult>
  }
>()("code/Sandbox") {}
