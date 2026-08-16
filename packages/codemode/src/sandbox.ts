import { Context, Effect } from "effect"

// The execution seam. A sandbox takes source and a set of named async functions and returns what
// the source evaluated to. Everything platform-specific sits behind it: a worker, an isolate, a
// micro-VM, a remote executor. The bindings are functions rather than data because an out-of-process
// sandbox proxies each call back over its own channel, and an in-process one calls them directly.
//
// The port carries no capability vocabulary. It knows source, names, and an outcome, so a
// deployment can swap the executor without touching the capabilities a program offers.

export interface SandboxRequest {
  readonly source: string
  // The names the source can reach, each an object of async methods.
  readonly api: Readonly<Record<string, Readonly<Record<string, (...args: ReadonlyArray<unknown>) => Promise<unknown>>>>>
  readonly timeoutMs?: number
}

export interface SandboxOutcome {
  // What the source evaluated to, when it completed.
  readonly value?: unknown
  // What the source printed. A script reports progress here without returning it.
  readonly output: ReadonlyArray<string>
  // Why the source stopped, when it did not complete.
  readonly error?: string
}

export class Sandbox extends Context.Service<
  Sandbox,
  { readonly run: (request: SandboxRequest) => Effect.Effect<SandboxOutcome> }
>()("flamecast/Sandbox") {}

const DEFAULT_TIMEOUT = 30_000

// Truncate a printed line so one runaway log cannot fill the event log.
const PRINT_LIMIT = 2_000

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: ReadonlyArray<string>
) => (...args: ReadonlyArray<unknown>) => Promise<unknown>

// The process-local executor. It runs the source in this process with the host's globals reachable,
// so it is an execution surface rather than a security boundary. It suits development, tests, and
// deployments whose source is already trusted, such as generated source that a reviewer approved.
// Bind an isolating implementation to run source a model wrote against data the
// model should not reach.
//
// It returns the service value, because the two ways to hold a service both take one:
// `Layer.succeed(Sandbox, inProcessSandbox())` binds it for a turn, and
// `Context.make(Sandbox, inProcessSandbox())` hands it to a session host.
export const inProcessSandbox = (): Sandbox["Service"] =>
  ({
    run: (request) =>
      Effect.gen(function* () {
        const output: Array<string> = []
        const print = (...values: ReadonlyArray<unknown>) => {
          const line = values
            .map((value) => (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)))
            .join(" ")
          output.push(line.length > PRINT_LIMIT ? `${line.slice(0, PRINT_LIMIT)}...` : line)
        }
        const names = Object.keys(request.api)
        // The source is the body of an async function, so a script both awaits and returns.
        const body = new AsyncFunction(...names, "print", request.source)
        const outcome = yield* Effect.tryPromise({
          try: () => body(...names.map((name) => request.api[name]), print),
          catch: (cause) => cause
        }).pipe(
          Effect.timeoutOption(request.timeoutMs ?? DEFAULT_TIMEOUT),
          Effect.match({
            onFailure: (cause): SandboxOutcome => ({
              output,
              error: cause instanceof Error ? cause.message : String(cause)
            }),
            onSuccess: (value): SandboxOutcome =>
              value._tag === "Some"
                ? { value: value.value, output }
                : { output, error: `the script ran longer than ${request.timeoutMs ?? DEFAULT_TIMEOUT}ms` }
          })
        )
        return outcome
      })
  }) satisfies Sandbox["Service"]
