import { Effect, Layer } from "effect"
import type {
  Ambient,
  Bindings,
  SandboxCallOutcome,
  SandboxPolicy,
  SandboxResult,
  SandboxService
} from "@clavia/tardigrade-code/sandbox"
import { DEFAULT_SANDBOX_POLICY, Sandbox } from "@clavia/tardigrade-code/sandbox"

export interface CloudflareSandboxLimits {
  readonly cpuMs?: number
  readonly subRequests?: number
}

export interface CloudflareSandboxPolicy extends SandboxPolicy {
  readonly compatibilityDate: string
  readonly compatibilityFlags: ReadonlyArray<string>
  readonly limits?: CloudflareSandboxLimits
  readonly globalOutbound: Fetcher | null
}

export const DEFAULT_CLOUDFLARE_SANDBOX_POLICY: CloudflareSandboxPolicy = {
  ...DEFAULT_SANDBOX_POLICY,
  compatibilityDate: "2026-08-08",
  compatibilityFlags: [],
  globalOutbound: null
}

export interface SandboxBridgeBinding {
  readonly sandboxCallBatch: (
    execution: string,
    calls: ReadonlyArray<SandboxBridgeCall>
  ) => Promise<ReadonlyArray<SandboxCallOutcome>>
}

export interface SandboxBridgeCall {
  readonly ordinal: number
  readonly packageName: string
  readonly method: string
  readonly args: unknown
}

export interface SandboxBridgeLease {
  readonly binding: SandboxBridgeBinding
  readonly execution: string
  readonly close: () => void
}

export type SandboxBridgeFactory = (
  call: (ordinal: number, packageName: string, method: string, args: unknown) => Promise<SandboxCallOutcome>
) => SandboxBridgeLease

const HARNESS_SOURCE = `
import body from "body.js";

const consoleShim = (lines, cap) => {
  let bytes = 0;
  let cut = false;
  const push = (args) => {
    if (bytes >= cap) {
      if (cut) return;
      cut = true;
      lines.push(\`…[console output cut at \${cap} bytes; later lines dropped]\`);
      return;
    }
    const line = args.map(String).join(" ");
    lines.push(line);
    bytes += line.length;
  };
  return {
    log: (...args) => push(args),
    warn: (...args) => push(args),
    error: (...args) => push(args),
    info: (...args) => push(args),
    debug: (...args) => push(args)
  };
};

const seededRandom = (seed) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const ambientShims = (ambient) => {
  const PinnedDate = class extends Date {
    constructor(...args) {
      if (args.length === 0) super(ambient.at);
      else super(...args);
    }
    static now() {
      return ambient.at;
    }
  };
  const PinnedMath = Object.create(Math, { random: { value: seededRandom(ambient.seed) } });
  return { Date: PinnedDate, Math: PinnedMath };
};

const response = (value) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" }
});

export default {
  async fetch(_request, env) {
    let ordinal = 0;
    let scheduled = false;
    let pending = [];
    const call = (packageName, method, args) => new Promise((resolve, reject) => {
      pending.push({ call: { ordinal: ordinal++, packageName, method, args }, resolve, reject });
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(async () => {
        const batch = pending;
        pending = [];
        scheduled = false;
        try {
          const outcomes = await env.BRIDGE.sandboxCallBatch(
            env.INPUT.execution,
            batch.map((entry) => entry.call)
          );
          for (let i = 0; i < batch.length; i++) {
            const outcome = outcomes[i];
            if (outcome === undefined) batch[i].reject(new Error("sandbox bridge omitted a call outcome"));
            else if (outcome._tag === "Returned") batch[i].resolve(outcome.result);
          }
        } catch (error) {
          for (const entry of batch) entry.reject(error);
        }
      });
    });
    const lines = [];
    const logs = () => lines.length === 0 ? {} : { logs: lines };
    const console = consoleShim(lines, env.INPUT.logCapBytes);
    const ambient = env.INPUT.ambient === undefined ? {} : ambientShims(env.INPUT.ambient);
    const args = env.INPUT.names.map((name) => {
      if (name === "console") return console;
      if (name === "Date" && ambient.Date !== undefined) return ambient.Date;
      if (name === "Math" && ambient.Math !== undefined) return ambient.Math;
      const methods = env.INPUT.packages[name];
      if (methods !== undefined) {
        return Object.fromEntries(methods.map((method) => [
          method,
          (args) => call(name, method, args)
        ]));
      }
      return env.INPUT.values[name];
    });
    try {
      return response({ result: await body(...args), ...logs() });
    } catch (error) {
      return response({ error: String(error), ...logs() });
    }
  }
};
`

const packageMethods = (binding: Bindings[string]): ReadonlyArray<string> | undefined => {
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) return undefined
  const entries = Object.entries(binding)
  if (!entries.every(([, method]) => typeof method === "function")) return undefined
  return entries.map(([method]) => method)
}

const bodySource = (names: ReadonlyArray<string>, code: string): string =>
  `export default async function(${names.join(",")}) {\n${code}\n}`

const scopeNames = (bindings: Bindings, ambient: Ambient | undefined): ReadonlyArray<string> =>
  Object.keys({ ...bindings, console: undefined, ...(ambient === undefined ? {} : { Date: undefined, Math: undefined }) })

const sandboxInput = (bindings: Bindings, ambient: Ambient | undefined, policy: CloudflareSandboxPolicy) => {
  const names = scopeNames(bindings, ambient)
  const packages: Record<string, ReadonlyArray<string>> = {}
  const values: Record<string, unknown> = {}
  for (const name of names) {
    if (name === "console" || (ambient !== undefined && (name === "Date" || name === "Math"))) continue
    const methods = packageMethods(bindings[name])
    if (methods === undefined) values[name] = bindings[name]
    else packages[name] = methods
  }
  return { names, packages, values, logCapBytes: policy.logCapBytes, ...(ambient === undefined ? {} : { ambient }) }
}

export const cloudflareSandboxServiceFor = (
  loader: WorkerLoader,
  bridgeFor: SandboxBridgeFactory,
  policy: Partial<CloudflareSandboxPolicy> = {}
): SandboxService => {
  const resolved: CloudflareSandboxPolicy = {
    logCapBytes: policy.logCapBytes ?? DEFAULT_CLOUDFLARE_SANDBOX_POLICY.logCapBytes,
    compatibilityDate: policy.compatibilityDate ?? DEFAULT_CLOUDFLARE_SANDBOX_POLICY.compatibilityDate,
    compatibilityFlags: policy.compatibilityFlags ?? DEFAULT_CLOUDFLARE_SANDBOX_POLICY.compatibilityFlags,
    ...(policy.limits === undefined ? {} : { limits: policy.limits }),
    globalOutbound: policy.globalOutbound === undefined
      ? DEFAULT_CLOUDFLARE_SANDBOX_POLICY.globalOutbound
      : policy.globalOutbound
  }
  return {
    run: (code, bindings, ambient) => Effect.promise(async (signal) => {
      try {
        const names = scopeNames(bindings, ambient)
        const call = (ordinal: number, packageName: string, method: string, args: unknown): Promise<SandboxCallOutcome> => {
          const binding = bindings[packageName]
          if (binding === null || typeof binding !== "object") {
            return Promise.reject(new Error(`sandbox package ${JSON.stringify(packageName)} is unavailable`))
          }
          const implementation = (binding as Readonly<Record<string, unknown>>)[method]
          if (typeof implementation !== "function") {
            return Promise.reject(new Error(`sandbox method ${JSON.stringify(`${packageName}.${method}`)} is unavailable`))
          }
          return implementation(args, ordinal)
        }
        const bridge = bridgeFor(call)
        try {
          const worker = loader.load({
          compatibilityDate: resolved.compatibilityDate,
          compatibilityFlags: [...resolved.compatibilityFlags],
          mainModule: "index.js",
          modules: {
            "index.js": HARNESS_SOURCE,
            "body.js": bodySource(names, code)
          },
          env: {
            BRIDGE: bridge.binding,
            INPUT: { ...sandboxInput(bindings, ambient, resolved), execution: bridge.execution }
          },
          globalOutbound: resolved.globalOutbound,
          ...(resolved.limits === undefined ? {} : { limits: resolved.limits })
        })
          const response = await worker.getEntrypoint().fetch(new Request("https://sandbox.invalid/run", {
            method: "POST",
            signal
          }))
          if (!response.ok) return { error: `sandbox returned HTTP ${response.status}` }
          return await response.json() as SandboxResult
        } finally {
          bridge.close()
        }
      } catch (error) {
        return { error: String(error) }
      }
    })
  }
}

export const layerCloudflareSandbox = (
  loader: WorkerLoader,
  bridgeFor: SandboxBridgeFactory,
  policy: Partial<CloudflareSandboxPolicy> = {}
): Layer.Layer<never> => Layer.succeed(Sandbox)(cloudflareSandboxServiceFor(loader, bridgeFor, policy))
