import type {
  SandboxProcessCall,
  SandboxProcessInbound,
  SandboxProcessRun,
  SandboxProcessSettled
} from "./sandbox-protocol"
import type { SandboxCallOutcome } from "@clavia/tardigrade-code/sandbox/service"

const send = process.send?.bind(process)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: ReadonlyArray<string>
) => (...bindings: ReadonlyArray<unknown>) => Promise<unknown>

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

const ambientShims = (ambient: NonNullable<SandboxProcessRun["ambient"]>): Record<string, unknown> => {
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

const consoleShim = (lines: string[], cap: number) => {
  let bytes = 0
  let cut = false
  const push = (args: ReadonlyArray<unknown>) => {
    if (bytes >= cap) {
      if (cut) return
      cut = true
      lines.push(`…[console output cut at ${cap} bytes; later lines dropped]`)
      return
    }
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

const pending = new Map<number, {
  readonly resolve: (outcome: SandboxCallOutcome) => void
  readonly reject: (error: Error) => void
}>()

const run = async (input: SandboxProcessRun): Promise<void> => {
  let ordinal = 0
  const lines: string[] = []
  const logs = () => (lines.length === 0 ? {} : { logs: lines })
  const calls = Object.fromEntries(Object.entries(input.packages).map(([packageName, methods]) => [
    packageName,
    Object.fromEntries(methods.map((method) => [
      method,
      (args: unknown) => new Promise<unknown>((resolve, reject) => {
        const position = ordinal++
        pending.set(position, {
          resolve: (outcome) => {
            if (outcome._tag === "Returned") resolve(outcome.result)
          },
          reject
        })
        const message: SandboxProcessCall = { type: "call", ordinal: position, packageName, method, args }
        send?.(message)
      })
    ]))
  ]))
  const ambient = input.ambient === undefined ? {} : ambientShims(input.ambient)
  const scope: Readonly<Record<string, unknown>> = {
    ...input.values,
    ...calls,
    console: consoleShim(lines, input.logCapBytes),
    ...(input.ambient === undefined ? {} : ambient)
  }
  try {
    const body = new AsyncFunction(...input.names, input.code)
    const result = await body(...input.names.map((name) => scope[name]))
    const message: SandboxProcessSettled = { type: "settled", outcome: { result, ...logs() } }
    send?.(message)
  } catch (error) {
    const message: SandboxProcessSettled = { type: "settled", outcome: { error: String(error), ...logs() } }
    send?.(message)
  }
}

process.on("message", (message: SandboxProcessInbound) => {
  if (message.type === "answer") {
    const continuation = pending.get(message.ordinal)
    if (continuation === undefined) return
    pending.delete(message.ordinal)
    if ("error" in message) continuation.reject(new Error(message.error))
    else continuation.resolve(message.outcome)
    return
  }
  void run(message)
})
