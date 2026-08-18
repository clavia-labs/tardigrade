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
export interface SandboxService {
  readonly run: (code: string, bindings: Bindings, ambient?: Ambient) => Effect.Effect<SandboxResult>
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: ReadonlyArray<string>
) => (...bindings: ReadonlyArray<unknown>) => Promise<unknown>

// consoleShim captures a body's console output into `lines`, capped in bytes so a print loop
// stays harmless. Past the cap, lines drop silently: prints are telemetry, never control flow.
export const LOG_CAP_BYTES = 8192
const consoleShim = (lines: string[]) => {
  let bytes = 0
  const push = (args: ReadonlyArray<unknown>) => {
    if (bytes >= LOG_CAP_BYTES) return
    const line = args.map(String).join(" ")
    lines.push(line)
    bytes += line.length
  }
  return {
    log: (...args: unknown[]) => push(args),
    warn: (...args: unknown[]) => push(args),
    error: (...args: unknown[]) => push(args),
    info: (...args: unknown[]) => push(args),
    debug: (...args: unknown[]) => push(args)
  }
}

// seededRandom is mulberry32 over an fnv-1a hash of the seed string: the
// same seed answers the same stream, which is the whole point.
const seededRandom = (seed: string): (() => number) => {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  let state = h >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ambientShims pins the body's clock and randomness to the execution's
// recorded ambient: Date.now and the no-argument Date constructor answer
// the dispatch instant, Math.random walks a seeded stream. Identical on
// every attempt by construction (Ambient above; the shims are bindings,
// so they shadow the globals inside the body).
const ambientShims = (ambient: Ambient): Record<string, unknown> => {
  const PinnedDate = class extends Date {
    constructor(...args: ReadonlyArray<unknown>) {
      if (args.length === 0) super(ambient.at)
      else super(...(args as ConstructorParameters<typeof Date>))
    }
    static override now(): number {
      return ambient.at
    }
  }
  const random = seededRandom(ambient.seed)
  const PinnedMath = Object.create(Math, { random: { value: random } }) as Math
  return { Date: PinnedDate, Math: PinnedMath }
}

// jsSandboxService runs the body as a plain async function. The body must stay deterministic
// between package calls (the contract above); nothing here enforces it. `console` is shadowed
// by a capturing shim (printed lines come back on the result's `logs`), and with an ambient,
// Date and Math are shadowed by replay-stable pins.
export const jsSandboxService: SandboxService = {
  run: (code: string, bindings: Bindings, ambient?: Ambient) =>
    Effect.promise(async () => {
      const lines: string[] = []
      const logs = () => (lines.length === 0 ? {} : { logs: lines })
      const scope: Bindings = {
        ...bindings,
        console: consoleShim(lines),
        ...(ambient === undefined ? {} : ambientShims(ambient))
      }
      try {
        const names = Object.keys(scope)
        const body = new AsyncFunction(...names, code)
        return { result: await body(...names.map((name) => scope[name])), ...logs() }
      } catch (e) {
        return { error: String(e), ...logs() }
      }
    })
}

export const Sandbox: Context.Reference<SandboxService> = Context.Reference("code/Sandbox", {
  defaultValue: () => jsSandboxService
})
