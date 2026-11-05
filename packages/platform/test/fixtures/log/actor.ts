import { Effect, Schema } from "effect"
import { act, actorMethod, defineActor, durableAtom, effectAtom, event } from "@clavia/tardigrade-core"
import { logTools } from "@clavia/tardigrade-libraries"

const Fact = Schema.Struct({ account: Schema.String, code: Schema.String, change: Schema.Int.annotate({ description: "Signed adjustment to the account balance." }) })
const BalanceRecorded = event({ type: "BalanceRecorded", ...Fact.fields })
const Call = Schema.Struct({ method: Schema.Literals(["describe", "query"]), input: Schema.Json })
const Requested = event({ type: "RecallRequested", id: Schema.String, ...Call.fields })
const Returned = event({ type: "RecallReturned", id: Schema.String, output: Schema.Json, error: Schema.NullOr(Schema.String) })
const Run = act({ name: "fixture.recall", input: Call, success: Schema.Json, failure: Schema.String })
const Pending = Schema.Struct({ status: Schema.Literal("pending"), origin: Schema.Int, ...Call.fields })
const Completed = Schema.Struct({ status: Schema.Literal("completed"), output: Schema.Json })
const Failed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String })

export const actor = defineActor("log-lifecycle", Effect.sync(() => {
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
export const services = Run.layer((request, context) => methods.get(request.method)!.invoke(request.input, { callId: String(context.ref.seq), name: request.method, input: request.input }).pipe(Effect.mapError(String)))
