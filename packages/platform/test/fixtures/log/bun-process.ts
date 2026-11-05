import { createInterface } from "node:readline"
import { Context, Effect, Layer, Schema } from "effect"
import { act, actorMethod, defineActor, durableAtom, effectAtom, event } from "@clavia/tardigrade-core"
import { logTools } from "@clavia/tardigrade-libraries"
import { bunJournal, bunLogSql, createBunHost } from "../../../src/bun"
import { bunThreadPath } from "../../../src/bun/observe"
import type { LogRequest, LogResponse, LogStatus } from "./shared"

const Fact = Schema.Struct({ account: Schema.String, code: Schema.String, change: Schema.Int.annotate({ description: "Signed adjustment to the account balance." }) })
const BalanceRecorded = event({ type: "BalanceRecorded", ...Fact.fields })
const Call = Schema.Struct({ method: Schema.Literals(["describe", "query"]), input: Schema.Json })
const Requested = event({ type: "RecallRequested", id: Schema.String, ...Call.fields })
const Returned = event({ type: "RecallReturned", id: Schema.String, output: Schema.Json, error: Schema.NullOr(Schema.String) })
const Run = act({ name: "fixture.recall", input: Call, success: Schema.Json, failure: Schema.String })
const Pending = Schema.Struct({ status: Schema.Literal("pending"), origin: Schema.Int, ...Call.fields })
const Completed = Schema.Struct({ status: Schema.Literal("completed"), output: Schema.Json })
const Failed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String })

const actor = defineActor("log-lifecycle", Effect.sync(() => {
  const calls = durableAtom({
    name: "fixture.calls", input: Schema.Union([Requested, Returned]),
    schema: Schema.Record(Schema.String, Schema.Union([Pending, Completed, Failed])), initial: {},
    reduce: (state, entry, _metadata, position) => ({ ...state, [entry.id]: entry.type === "RecallRequested"
      ? { status: "pending" as const, origin: position, method: entry.method, input: entry.input }
      : entry.error === null ? { status: "completed" as const, output: entry.output } : { status: "failed" as const, error: entry.error } }),
  })
  const requests = new Map<string, ReturnType<typeof Run.request>>()
  return {
    atom: effectAtom(get => ({
      view: get(calls), events: {},
      acts: Object.fromEntries(Object.entries(get(calls)).flatMap(([id, call]) => {
        if (call.status !== "pending") return []
        let request = requests.get(id)
        if (!request) {
          request = Run.request({ origin: call.origin, input: { method: call.method, input: call.input }, onSettled: result => [Returned.make(result.status === "fulfilled"
            ? { id, output: result.value, error: null } : { id, output: null, error: String(result.reason) })] })
          requests.set(id, request)
        }
        return [[id, request]]
      })),
    })),
    methods: {
      record: actorMethod({ inputSchema: Fact, outputSchema: Schema.Null, onReceive: BalanceRecorded.from(input => input), result: () => ({ status: "completed", output: null }) }),
      recall: actorMethod({
        inputSchema: Call, outputSchema: Schema.Json,
        onReceive: Requested.from((input, context) => ({ ...input, id: context.id })),
        result: (_input, get, context) => { const result = get(calls)[context.id]; return result?.status === "pending" ? undefined : result },
      }),
    },
  }
}))
const library = logTools()
const methods = new Map(library.methods.map((method, index) => [library.library.specs[index]!.method, method]))
const services = Run.layer((request, context) => methods.get(request.method)!.invoke(request.input, { callId: String(context.ref.seq), name: request.method, input: request.input }).pipe(Effect.mapError(String))).pipe(Layer.provide(bunLogSql()))
const storage = process.argv[2]!
const host = await Effect.runPromise(createBunHost({ actor, actorContext: Context.pick(), storage, services: () => services, checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } } }))
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
