import { Effect, Random, Schema } from "effect"
import { actorMethod, defineActor, effectAtom, event } from "@clavia/tardigrade-core"
import { atomPopulation, Changed, type AtomPopulationKind } from "./population"

export const CHECKPOINT_E2E_ACTOR = "checkpoint-e2e"
export const checkpointE2EInstance = (kind: AtomPopulationKind) => `${CHECKPOINT_E2E_ACTOR}-${kind}`
const ReadRequested = event({ type: "ReadRequested", id: Schema.String })
const DiagnosticsRequested = event({ type: "DiagnosticsRequested" })
export interface CheckpointDiagnostics {
  readonly instance: string
  readonly reductions: Readonly<Record<string, number>>
}

// checkpointActor keeps dormant counters resident across checkpoint writes (properties/checkpoint/e2e.ts).
export const checkpointActor = (kind: AtomPopulationKind) => defineActor(CHECKPOINT_E2E_ACTOR, Effect.gen(function* () {
  const population = atomPopulation(kind, "checkpoint.e2e", { idleTTL: Infinity })
  const instance = (yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt])).join(":")
  const member = (id: string) => {
    const found = population.members.find(member => member.key === id)
    if (!found) throw new Error(`Unknown checkpoint counter: ${id}`)
    return found.node
  }
  return { schema: Schema.Union([Changed, ReadRequested, DiagnosticsRequested]),
    atom: effectAtom(() => ({ view: null, events: {}, acts: {} })),
    methods: {
      change: actorMethod({ inputSchema: Schema.Struct({ id: Schema.String, amount: Schema.Int }), outputSchema: Schema.Null,
        onReceive: Changed.from((input: { readonly id: string; readonly amount: number }) => input), result: () => ({ status: "completed", output: null }),
      }),
      read: actorMethod({ inputSchema: Schema.String, outputSchema: Schema.Int,
        onReceive: ReadRequested.from((id: string) => ({ id })), result: (id, get) => ({ status: "completed", output: get(member(id)) }),
      }),
      diagnostics: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Struct({ instance: Schema.String, reductions: Schema.Record(Schema.String, Schema.Int) }),
        onReceive: DiagnosticsRequested.from(() => ({})), result: () => ({ status: "completed", output: {
          instance, reductions: Object.fromEntries(population.members.map(member => [member.key, member.reductions])),
        } }),
      }),
    },
  }
}))
