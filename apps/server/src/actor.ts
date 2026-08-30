import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { Actor } from "@clavia/tardigrade-core/actor"
import {
  actor,
  agentMethods,
  agentsPackage,
  budget,
  budgetAuthority,
  caller,
  codeMode,
  compaction,
  fetchPackage,
  filesPackage,
  infer,
  outputValidateOnce,
  workspacePackage,
  type AgentCatalog,
  type ModelRef
} from "tardie"
import { turnEpochOf } from "@clavia/tardigrade-code/execution/turns"
import { boundaryOf } from "tardie/output/boundary"
import { projection, projectionsOf, RESERVED_ACTOR, Seq, TurnView } from "@clavia/tardigrade-client/contract"

import { inboundOf } from "./projections"

// The actor this build serves: the reactors it runs, and the projections it declares over the logs
// they write. Both halves belong together, because a projection is only meaningful to whoever knows
// what the events mean, and that is the assembly that emitted them. The platform holds the log and
// mounts what is declared here by name (packages/client/src/contract.ts, apiOf).

// The assembly, one for every thread: code mode with four packages in scope, plus the policy
// components. v1 runs this one assembly and forking is the customization path (apps-server-spec.md,
// "Explicitly out of scope for v1").
//
// outputValidateOnce makes the server's handling explicit when its run-time model configuration supplies no native type proof.
//
// What the four packages add up to is what this actor can reach. `agents` fans work out to children
// and `workspace` reads what a result spilled, both inside the log. `files` reads and writes under
// one root directory, the working directory of the process that booted, and `fetch` makes HTTP
// requests to any host. There is no shell: a shell cannot be scoped the way a root or an origin can,
// and this build has no place to ask an operator whether one command is allowed.
export interface AssemblyModelPolicy {
  readonly contextWindowTokens?: number | ((model: ModelRef | undefined) => number)
  readonly catalog?: AgentCatalog
}

export const UNCONFIGURED_MODEL: AssemblyModelPolicy = {}

const assemblyOf = (models: AssemblyModelPolicy = UNCONFIGURED_MODEL) =>
  actor({
    name: RESERVED_ACTOR,
    methods: agentMethods,
    components: [
      infer([
        budget([codeMode([
          agentsPackage(models.catalog === undefined ? {} : { catalog: models.catalog }),
          workspacePackage(),
          filesPackage(),
          fetchPackage()
        ])], { authority: caller() }),
        compaction(models.contextWindowTokens === undefined ? {} : { contextWindowTokens: models.contextWindowTokens }),
        outputValidateOnce
      ]),
      budgetAuthority()
    ]
  })

// builtInActor declares the built-in assembly and its callable interface together.
export const builtInActor = assemblyOf

// ServerR is what this assembly needs bound. It is read off the assembly rather than restated, so a
// package added above lands in the host's obligation and a host that binds nothing for it fails to
// compile (host.ts, layerThread).
export type ServerR = ReturnType<typeof assemblyOf> extends Actor<infer R> ? R : never

// TurnStatus is this actor's turn vocabulary. `parked` is the budget ask nobody can answer over
// HTTP (apps-server-spec.md, "Explicitly out of scope": budget escalation).
export type TurnStatus = "pending" | "completed" | "failed" | "cancelled" | "parked"

export interface TurnViewShape {
  readonly turn: string
  readonly status: TurnStatus
  // The execution epoch the active attempt belongs to, zero until an operator has resumed the turn.
  // It is on the wire because resuming stamps the next one (packages/agent/src/runtime/resume.ts).
  readonly epoch: number
  readonly output?: string
  readonly error?: string
  readonly reason?: string
}

// turnsOf projects one turn per inbound message, in the order the messages arrived. `at` cuts the
// log to a prefix first: any prefix of a log is a valid state, so time travel is this one argument
// and never a stored mode (apps-server-spec.md, "Principles"). A prefix taken before a turn's
// terminal reads that turn pending again (actor.test.ts, "a prefix takes a turn back to pending"),
// and a prefix taken before a message drops its turn from the list entirely.
//
// `turn` narrows the answer to one entry, which is what makes the single lookup a query on this
// projection rather than a route of its own: a turn nobody was asked to serve simply matches
// nothing, so the answer is an empty array and not a failure (actor.test.ts, "a turn nobody was
// asked to serve matches nothing").
const turnsOf = (
  events: ReadonlyArray<Event>,
  params: { readonly at?: number; readonly turn?: string }
): ReadonlyArray<TurnViewShape> => {
  const prefix = events.slice(0, params.at ?? events.length)
  const wanted = params.turn
  return inboundOf(prefix)
    .filter((turn) => wanted === undefined || turn === wanted)
    .map((turn): TurnViewShape => {
      const epoch = turnEpochOf(prefix, turn)
      const boundary = boundaryOf(prefix, turn)
      if (boundary === undefined) return { turn, status: "pending", epoch }
      if (boundary.kind === "completed") return { turn, status: "completed", epoch, output: boundary.output }
      if (boundary.kind === "failed") return { turn, status: "failed", epoch, error: boundary.error }
      if (boundary.kind === "cancelled") return {
        turn,
        status: "cancelled",
        epoch,
        ...(boundary.reason === undefined ? {} : { reason: boundary.reason })
      }
      // A park is neither an output nor an error: the turn is alive and waiting on an answer the API
      // has no door for, so the status carries the whole of what a client can act on.
      return { turn, status: "parked", epoch }
    })
}

// What this actor answers about a thread beyond its log. A turn is not a fact the platform knows:
// it is this assembly's reading of MessageReceived and the terminals its reactors write, so the
// platform mounts the reading rather than holding it (api.test.ts, "a declared projection serves
// what the actor computes").
export const agentProjections = projectionsOf({
  turns: projection({
    params: { at: Schema.optionalKey(Seq), turn: Schema.optionalKey(Schema.String) },
    result: Schema.Array(TurnView),
    run: turnsOf
  })
})
