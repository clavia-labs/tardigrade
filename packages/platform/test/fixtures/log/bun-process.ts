import { createInterface } from "node:readline"
import { Context, Effect } from "effect"
import { actor, services } from "./actor"
import { bunJournal, createBunHost } from "../../../src/bun"
import { bunThreadPath } from "../../../src/bun/observe"
import type { LogRequest, LogResponse, LogStatus } from "./shared"

const storage = process.argv[2]!
const host = await Effect.runPromise(createBunHost({ actor, actorContext: Context.pick(), storage, eventInlineBytes: 64, checkpointChunkBytes: 31, services: () => services, checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } } }))
const send = (response: LogResponse) => process.stdout.write(`${JSON.stringify(response)}\n`)
const status = async (thread: string): Promise<LogStatus> => {
  const journal = bunJournal({ filename: bunThreadPath(storage, { actor: actor.actorName, instance: "scenario", thread }), actor: "events" })
  try { return { records: journal.readPosition(), checkpoint: journal.readCheckpoint()?.position ?? null } }
  finally { await Effect.runPromise(journal.close) }
}
async function handle(request: LogRequest): Promise<LogResponse> {
  try {
    const thread = await Effect.runPromise(host.allocateRootThread({ instance: "scenario", name: request.thread }))
    if (request.type === "status") return { type: "result", value: await status(request.thread) }
    const value = request.type === "record"
      ? await Effect.runPromise(thread.methods.record(request.fact, { id: request.id }))
      : await Effect.runPromise(thread.methods.recall({ method: request.method, input: request.input }, { id: request.id }))
    await Effect.runPromise(thread.wait)
    if (request.type === "recall" && request.loseReply) {
      send({ type: "boundary", status: await status(request.thread) })
      return await Effect.runPromise(Effect.never)
    }
    return { type: "result", value }
  } catch (error) { return { type: "error", message: String(error) } }
}
try {
  send({ type: "ready" })
  for await (const line of createInterface({ input: process.stdin })) send(await handle(JSON.parse(line) as LogRequest))
} finally { await Effect.runPromise(host.close) }
