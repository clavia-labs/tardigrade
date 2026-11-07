import type { Machine, MachineSpec } from "@boxd-sh/sdk"
import type { BoxdWorkspaceClient } from "../../../src/boxd/workspace"

interface FakeComputer {
  readonly id: string
  readonly name: string
  readonly region: string
  status: Machine["status"]
  readonly egressAllow: readonly string[]
  readonly isolated: boolean
}

const never = () => new Promise<never>(() => {})
async function* chunks(hang: boolean): AsyncGenerator<Uint8Array> { if (hang) await never() }

// fakeBoxd injects discovery, startup, and stream failures (packages/platform/test/bun/workspace/boxd.test.ts).
export function fakeBoxd(options: { readonly hangCommand?: boolean } = {}) {
  const computers = new Map<string, FakeComputer>()
  const calls: string[] = []
  const unavailable: string[] = []
  const before: Record<string, () => Promise<void>> = {}
  let sequence = 0
  const record = async (method: string) => { calls.push(method); await before[method]?.() }
  const lookup = (id: string) => {
    const computer = computers.get(id)
    if (!computer) throw new Error(`Unknown fixture computer: ${id}`)
    return computer
  }
  const machine = (computer: FakeComputer) => ({ ...computer, networking: { networks: [], isolated: computer.isolated } })
  const add = (input: { readonly name: string; readonly region?: string; readonly status?: Machine["status"]; readonly egress?: readonly string[]; readonly isolated?: boolean }) => {
    const computer: FakeComputer = { id: `vm-${++sequence}`, name: input.name, region: input.region ?? "fra", status: input.status ?? "running", egressAllow: input.egress ?? [], isolated: input.isolated ?? true }
    computers.set(computer.id, computer)
    return computer
  }
  const client = {
    machines: {
      create: async (params: { readonly name: string; readonly region?: string; readonly spec: MachineSpec }) => {
        await record("create")
        return machine(add({ name: params.name, ...(params.region ? { region: params.region } : {}), status: "starting", egress: params.spec.egress ?? [], isolated: params.spec.isolated ?? false }))
      },
      list: async (params: { readonly region?: string }) => {
        await record("list")
        const listed = [...computers.values()].filter(computer => computer.status !== "destroyed" && !unavailable.includes(computer.region) && (params.region === undefined || params.region === "all" || computer.region === params.region)).map(machine)
        return Object.assign(listed, { elsewhere: [], unavailable })
      },
      get: async (id: string) => { await record("get"); return machine(lookup(id)) },
      start: async (id: string) => { await record("start"); lookup(id).status = "starting" },
      waitUntilReady: async (id: string) => { await record("waitUntilReady"); const computer = lookup(id); computer.status = "running"; return machine(computer) },
      hibernate: async (id: string) => { await record("hibernate"); lookup(id).status = "hibernated" },
      delete: async (id: string) => { await record("delete"); lookup(id).status = "destroyed" },
      streamExec: (_id: string, params: { readonly command: string[] }) => {
        calls.push("streamExec")
        const hang = options.hangCommand === true && params.command[0] !== "true"
        return { stdout: chunks(hang), stderr: chunks(hang), wait: async () => { if (hang) await never(); return 0 }, close: () => { calls.push("close") } }
      },
      fs: {
        readStream: () => { throw new Error("Unexpected fixture file read") },
        write: async () => { throw new Error("Unexpected fixture file write") },
        mkdir: async () => {},
      },
    },
  }
  return { client: client as unknown as BoxdWorkspaceClient, computers, calls, add, unavailable, before }
}
