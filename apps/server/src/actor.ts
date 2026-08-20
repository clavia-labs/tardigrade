import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import {
  agentOf,
  agentsPackage,
  budget,
  codeModeFor,
  compaction,
  reply,
  workspacePackage
} from "@clavia/tardigrade"
import { turnEpochOf } from "@clavia/tardigrade-code/turns"
import { boundaryOf } from "@clavia/tardigrade/boundary"
import { projection, projectionsOf, Seq, TurnView } from "@clavia/tardigrade-client/contract"

import { inboundOf } from "./projections"

// The actor this build serves: the reactors it runs, and the projections it declares over the logs
// they write. Both halves belong together, because a projection is only meaningful to whoever knows
// what the events mean, and that is the assembly that emitted them. The platform holds the log and
// mounts what is declared here by name (packages/client/src/contract.ts, apiOf).

// The assembly, one for every lane: code mode with the spawn and workspace packages in scope, plus
// the three policy capabilities. v1 runs this one assembly and forking is the customization path
// (apps-server-spec.md, "Explicitly out of scope for v1").
export const assemblyOf = () =>
  agentOf([
    codeModeFor({ packages: [agentsPackage(), workspacePackage()] }),
    reply,
    budget,
    compaction
  ])

// TurnStatus is this actor's turn vocabulary. `parked` is the budget ask nobody can answer over
// HTTP (apps-server-spec.md, "Explicitly out of scope": budget escalation).
export type TurnStatus = "pending" | "completed" | "failed" | "parked"

export interface TurnViewShape {
  readonly turn: string
  readonly status: TurnStatus
  // The execution epoch the active attempt belongs to, zero until an operator has resumed the turn.
  // It is on the wire because resuming stamps the next one (packages/agent/src/resume.ts).
  readonly epoch: number
  readonly output?: string
  readonly error?: string
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
