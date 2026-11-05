import type { Machine, MachineSpec } from "@boxd-sh/sdk"
import type { BoxdWorkspaceClient } from "../../../src/boxd/workspace"

export interface FakeComputer {
  readonly id: string
  readonly name: string
  readonly region: string
  status: Machine["status"]
  egressAllow: string[]
  readonly isolated: boolean
  readonly spec: MachineSpec | undefined
  readonly files: Map<string, Uint8Array>
}

interface FakeExecResult { readonly stdout?: string; readonly stderr?: string; readonly code?: number; readonly hang?: boolean }
export type FakeExec = (command: readonly string[], computer: FakeComputer, cwd: string | undefined) => FakeExecResult

interface FakeCall { readonly method: string; readonly id?: string; readonly region?: string; readonly detail?: unknown }

class FakeBoxdError extends Error {
  constructor(name: "NotFoundError" | "ConflictError" | "MachineFileNotFoundError", message: string) {
    super(message)
    this.name = name
  }
}

const bytes = (text: string) => new TextEncoder().encode(text)

const never = () => new Promise<never>(() => {})

async function* chunks(text: string | undefined, failure: Error | undefined, hang: boolean | undefined): AsyncGenerator<Uint8Array> {
  if (failure) throw failure
  if (hang) await never()
  if (text) yield bytes(text)
}

// fakeBoxd keeps computers in memory and answers the client calls a boxd workspace makes, with the failures live testing found.
export function fakeBoxd(exec: FakeExec = command => command[0] === "true" ? {} : { stdout: `ran ${command.join(" ")}\n` }) {
  const computers = new Map<string, FakeComputer>()
  const calls: FakeCall[] = []
  // unavailable names regions that leave list without an answer; before holds a step a test awaits ahead of a call's effect.
  const unavailable: string[] = []
  const before: { [method: string]: () => Promise<void> } = {}
  let sequence = 0
  const record = async (method: string, id?: string, options?: { readonly region?: string }, detail?: unknown) => {
    calls.push({ method, ...(id ? { id } : {}), ...(options?.region ? { region: options.region } : {}), ...(detail === undefined ? {} : { detail }) })
    await before[method]?.()
  }
  const lookup = (id: string) => {
    const computer = computers.get(id)
    if (!computer || computer.status === "destroyed") throw new FakeBoxdError("NotFoundError", `VM not found (region ${[...computers.values()][0]?.region ?? "fra"})`)
    return computer
  }
  const usable = (id: string) => {
    const computer = lookup(id)
    if (computer.status === "stopped") throw new FakeBoxdError("ConflictError", `VM ${computer.name} is stopped, so it won't be resumed automatically. Start it first`)
    if (computer.status === "suspended" || computer.status === "hibernated") computer.status = "running"
    return computer
  }
  const machine = (computer: FakeComputer) => ({
    id: computer.id, name: computer.name, status: computer.status, region: computer.region,
    egressAllow: [...computer.egressAllow], networking: { networks: [], isolated: computer.isolated }, spec: computer.spec ?? null,
  }) as unknown as Machine
  const add = (input: { readonly name: string; readonly region?: string; readonly status?: Machine["status"]; readonly egress?: readonly string[]; readonly isolated?: boolean; readonly spec?: MachineSpec }) => {
    const computer: FakeComputer = { id: `vm-${++sequence}`, name: input.name, region: input.region ?? "fra", status: input.status ?? "running", egressAllow: [...input.egress ?? []], isolated: input.isolated ?? true, spec: input.spec, files: new Map() }
    computers.set(computer.id, computer)
    return computer
  }
  const client = {
    machines: {
      create: async (params: { readonly name?: string; readonly region?: string; readonly spec?: MachineSpec }) => {
        await record("create", undefined, params, params)
        const spec = params.spec
        return machine(add({ name: params.name ?? `vm-${sequence + 1}`, ...(params.region ? { region: params.region } : {}), status: "starting", egress: spec?.egress ?? [], isolated: spec?.isolated ?? false, ...(spec ? { spec } : {}) }))
      },
      list: async (params: { readonly region?: string; readonly org?: string }) => {
        await record("list", undefined, params, params)
        const listed = [...computers.values()].filter(computer => computer.status !== "destroyed" && !unavailable.includes(computer.region) && (params.region === undefined || params.region === "all" || computer.region === params.region)).map(machine)
        return Object.assign(listed, { elsewhere: [], unavailable: [...unavailable] })
      },
      get: async (id: string, options?: { readonly region?: string }) => { await record("get", id, options); return machine(lookup(id)) },
      start: async (id: string, options?: { readonly region?: string }) => { await record("start", id, options); lookup(id).status = "starting" },
      waitUntilReady: async (id: string, options?: { readonly region?: string; readonly timeout?: number; readonly pollInterval?: number }) => { await record("waitUntilReady", id, options, options); const computer = lookup(id); computer.status = "running"; return machine(computer) },
      hibernate: async (id: string, options?: { readonly region?: string }) => { await record("hibernate", id, options); lookup(id).status = "hibernated" },
      delete: async (id: string, options?: { readonly region?: string }) => { await record("delete", id, options); lookup(id).status = "destroyed" },
      streamExec: (id: string, params: { readonly command: string | string[]; readonly cwd?: string; readonly region?: string }) => {
        void record("streamExec", id, params, params.command)
        const command = typeof params.command === "string" ? ["sh", "-c", params.command] : params.command
        let failure: Error | undefined
        let result: FakeExecResult = {}
        const deleted = computers.get(id)?.status === "destroyed"
        try { if (!deleted) result = exec(command, usable(id), params.cwd) } catch (error) { failure = error instanceof Error ? error : new Error(String(error)) }
        return {
          stdout: chunks(result.stdout, failure, result.hang), stderr: chunks(result.stderr, failure, result.hang),
          wait: async () => { if (failure) throw failure; if (result.hang) await never(); return deleted ? -1 : result.code ?? 0 },
          close: () => {},
        }
      },
      fs: {
        readStream: async function* (id: string, path: string, options?: { readonly region?: string }) {
          await record("fs.readStream", id, options, path)
          const content = usable(id).files.get(path)
          if (!content) throw new FakeBoxdError("MachineFileNotFoundError", `${path}: No such file or directory`)
          if (content.byteLength) yield content
        },
        write: async (id: string, path: string, data: string | Uint8Array, options?: { readonly region?: string }) => { await record("fs.write", id, options, path); usable(id).files.set(path, typeof data === "string" ? bytes(data) : data) },
        mkdir: async (id: string, path: string, options?: { readonly region?: string }) => { await record("fs.mkdir", id, options, path); usable(id) },
      },
    },
  }
  // The fake implements the calls a workspace makes with the same names and shapes; the SDK's full overload set is not reproduced.
  return { client: client as unknown as BoxdWorkspaceClient, computers, calls, add, unavailable, before, methods: () => calls.map(call => call.method) }
}
