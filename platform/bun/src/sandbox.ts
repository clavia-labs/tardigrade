import { Effect, Layer } from "effect"
import type {
  Ambient,
  Bindings,
  SandboxCall,
  SandboxPolicy,
  SandboxResult,
  SandboxService
} from "@clavia/tardigrade-code/sandbox/service"
import { DEFAULT_SANDBOX_POLICY, Sandbox } from "@clavia/tardigrade-code/sandbox/service"
import type {
  SandboxProcessCall,
  SandboxProcessInbound,
  SandboxProcessOutbound,
  SandboxProcessRun
} from "./sandbox-protocol"

export interface BunSandboxPolicy extends SandboxPolicy {
  readonly segmentTimeoutMs: number
}

export const DEFAULT_BUN_SANDBOX_POLICY: BunSandboxPolicy = {
  ...DEFAULT_SANDBOX_POLICY,
  segmentTimeoutMs: 30_000
}

const packageMethods = (binding: Bindings[string]): ReadonlyArray<string> | undefined => {
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) return undefined
  const entries = Object.entries(binding)
  if (!entries.every(([, method]) => typeof method === "function")) return undefined
  return entries.map(([method]) => method)
}

const RESTRICTED_NAMES = [
  "globalThis",
  "self",
  "postMessage",
  "fetch",
  "process",
  "Bun",
  "Worker",
  "Function",
  "require"
] as const

const processInput = (
  code: string,
  bindings: Bindings,
  ambient: Ambient | undefined,
  policy: BunSandboxPolicy
): SandboxProcessRun => {
  const packages: Record<string, ReadonlyArray<string>> = {}
  const values: Record<string, unknown> = {}
  for (const [name, binding] of Object.entries(bindings)) {
    const methods = packageMethods(binding)
    if (methods === undefined) values[name] = binding
    else packages[name] = methods
  }
  for (const name of RESTRICTED_NAMES) {
    if (Object.hasOwn(bindings, name)) continue
    values[name] = name === "globalThis" ? Object.freeze({}) : undefined
  }
  const names = [
    ...Object.keys(bindings),
    "console",
    ...(ambient === undefined ? [] : ["Date", "Math"]),
    ...RESTRICTED_NAMES.filter((name) => !Object.hasOwn(bindings, name))
  ]
  return {
    type: "run",
    code,
    names,
    packages,
    values,
    logCapBytes: policy.logCapBytes,
    ...(ambient === undefined ? {} : { ambient })
  }
}

const callFrom = (bindings: Bindings, message: SandboxProcessCall): Promise<Awaited<ReturnType<SandboxCall>>> => {
  const binding = bindings[message.packageName]
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
    return Promise.reject(new Error(`sandbox package ${JSON.stringify(message.packageName)} is unavailable`))
  }
  const implementation = (binding as Readonly<Record<string, unknown>>)[message.method]
  if (typeof implementation !== "function") {
    return Promise.reject(new Error(`sandbox method ${JSON.stringify(`${message.packageName}.${message.method}`)} is unavailable`))
  }
  return Promise.resolve().then(() => (implementation as SandboxCall)(message.args, message.ordinal))
}

const outboundMessage = (value: unknown): SandboxProcessOutbound | undefined => {
  if (value === null || typeof value !== "object") return undefined
  const message = value as Readonly<Record<string, unknown>>
  if (message.type === "settled" && message.outcome !== null && typeof message.outcome === "object") {
    return value as SandboxProcessOutbound
  }
  if (
    message.type === "call" &&
    Number.isInteger(message.ordinal) &&
    typeof message.packageName === "string" &&
    typeof message.method === "string"
  ) return value as SandboxProcessOutbound
  return undefined
}

export const bunSandboxServiceFor = (
  policy: Partial<BunSandboxPolicy> = {}
): SandboxService => {
  const resolved: BunSandboxPolicy = {
    logCapBytes: policy.logCapBytes ?? DEFAULT_BUN_SANDBOX_POLICY.logCapBytes,
    segmentTimeoutMs: policy.segmentTimeoutMs ?? DEFAULT_BUN_SANDBOX_POLICY.segmentTimeoutMs
  }
  return {
    run: (code, bindings, ambient) => Effect.promise((signal) => new Promise<SandboxResult>((resolve) => {
      let finished = false
      let inFlight = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const child = Bun.spawn({
        cmd: [process.execPath, new URL("./sandbox-process.ts", import.meta.url).pathname],
        env: {},
        ipc: (value) => {
          const message = outboundMessage(value)
          if (message === undefined) finish({ error: "sandbox process sent an invalid message" })
          else receive(message)
        },
        serialization: "advanced",
        stderr: "ignore",
        stdout: "ignore"
      })
      const stopTimer = () => {
        if (timer === undefined) return
        clearTimeout(timer)
        timer = undefined
      }
      const finish = (outcome: SandboxResult) => {
        if (finished) return
        finished = true
        stopTimer()
        try {
          child.kill()
        } catch (error) {
          void error
        }
        resolve(outcome)
      }
      const startTimer = () => {
        stopTimer()
        timer = setTimeout(
          () => finish({ error: `sandbox exceeded its ${resolved.segmentTimeoutMs} ms execution-segment limit` }),
          resolved.segmentTimeoutMs
        )
      }
      signal.addEventListener("abort", () => finish({ error: "sandbox execution interrupted" }), { once: true })
      const receive = (message: SandboxProcessOutbound) => {
        if (message.type === "settled") {
          finish(message.outcome)
          return
        }
        inFlight++
        stopTimer()
        void callFrom(bindings, message).then(
          (outcome) => send({ type: "answer", ordinal: message.ordinal, outcome }),
          (error) => send({ type: "answer", ordinal: message.ordinal, error: String(error) })
        ).finally(() => {
          inFlight--
          if (inFlight === 0 && !finished) startTimer()
        })
      }
      const send = (message: SandboxProcessInbound) => {
        if (finished) return
        try {
          child.send(message)
        } catch (error) {
          finish({ error: `sandbox process communication failed: ${String(error)}` })
        }
      }
      void child.exited.then((code) => {
        if (!finished) finish({ error: `sandbox process exited with code ${code}` })
      })
      startTimer()
      send(processInput(code, bindings, ambient, resolved))
    }))
  }
}

export const bunSandbox: Layer.Layer<never> = Layer.succeed(Sandbox)(bunSandboxServiceFor())

export const bunSandboxFor = (
  policy: Partial<BunSandboxPolicy>
): Layer.Layer<never> => Layer.succeed(Sandbox)(bunSandboxServiceFor(policy))
