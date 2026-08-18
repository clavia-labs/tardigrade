import { Effect, Layer } from "effect"
import { Sandbox, type Ambient, type Bindings } from "./sandbox"
import { Tmp } from "./tmp"

// The code lane's default seam bindings: a plain async-function sandbox
// and a memory tmp store. The platform binds isolates and durable
// storage instead; tests and the memory host bind these.

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
// every attempt by construction (packages/code/src/sandbox.ts, Ambient;
// the shims are bindings, so they shadow the globals inside the body).
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

// jsSandbox runs the body as a plain async function. The body must stay
// deterministic between package calls (packages/code/src/sandbox.ts);
// nothing here enforces it. `console` is shadowed by a capturing shim
// (printed lines come back on the result's `logs`), and with an ambient,
// Date and Math are shadowed by replay-stable pins.
export const jsSandbox: Layer.Layer<Sandbox> = Layer.succeed(Sandbox, {
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
})

// memoryTmp holds spilled values in a Map: replay hydrates from it for
// the life of the process.
export const memoryTmp = (): Layer.Layer<Tmp> => {
  const store = new Map<string, string>()
  return Layer.succeed(Tmp, {
    store: (ref: string, json: string) => Effect.sync(() => void store.set(ref, json)),
    load: (ref: string) => Effect.sync(() => store.get(ref))
  })
}
