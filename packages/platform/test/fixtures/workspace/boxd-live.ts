import { Boxd } from "@boxd-sh/sdk"
import { Effect, ManagedRuntime } from "effect"
import { FilesystemWorkspace, type FilesystemWorkspaceService } from "@clavia/tardigrade-libraries/filesystem/index"
import { boxdWorkspace, type BoxdWorkspaceOptions } from "../../../src/boxd/workspace"

const BOXD_LIVE_PREFIX = process.env.BOXD_TEST_PREFIX ?? "tardigrade-e2e-"
export const BOXD_LIVE_TIMEOUT_MS = Number(process.env.BOXD_TEST_TIMEOUT_MS ?? 180_000)
export const BOXD_LIVE_STAGE_MS = Number(process.env.BOXD_TEST_STAGE_MS ?? 60_000)

// liveBoxd builds a client from BOXD_API_KEY; the live suite refuses to run without one so a missing credential is never a pass.
export function liveBoxd() {
  if (!process.env.BOXD_API_KEY && !process.env.BOXD_TOKEN) throw new Error("Set BOXD_API_KEY (and BOXD_ORG for a key fenced to another org) to run the boxd workspace suite")
  return { client: new Boxd(), org: process.env.BOXD_ORG }
}

export const liveName = (label: string) => `${BOXD_LIVE_PREFIX}${label}-${crypto.randomUUID().slice(0, 8)}`

// removeComputer deletes every computer with the name, in every region, and reports how many it removed.
export async function removeComputer(client: Boxd, org: string | undefined, name: string): Promise<number> {
  const listed = await client.machines.list({ ...(org ? { org } : {}), region: "all" })
  const matches = listed.filter(machine => machine.name === name)
  for (const machine of matches) await client.machines.delete(machine.id, machine.region ? { region: machine.region } : {})
  return matches.length
}

// findComputer returns the computer with the name, or undefined once it is gone.
export async function findComputer(client: Boxd, org: string | undefined, name: string) {
  return (await client.machines.list({ ...(org ? { org } : {}), region: "all" })).find(machine => machine.name === name)
}

// withLiveWorkspace runs one layer lifetime, so release runs before it returns.
export async function withLiveWorkspace<A>(options: BoxdWorkspaceOptions, run: (workspace: FilesystemWorkspaceService) => Promise<A>): Promise<A> {
  const runtime = ManagedRuntime.make(boxdWorkspace(options))
  try { return await run(await runtime.runPromise(Effect.map(FilesystemWorkspace, workspace => workspace))) } finally { await runtime.dispose() }
}
