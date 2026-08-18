import { Effect, Layer } from "effect"
import type { Envelope } from "@flamecast/core/envelope"
import { Router } from "@flamecast/core/router"
import { Packages, type Package } from "@flamecast/code/packages"
import { jsSandbox, memoryTmp } from "@flamecast/code/defaults"
import { createHost, type Host } from "@flamecast/host/host"
import { agent, type AgentR } from "./turn"
import { Infer } from "./infer"
import type { Action } from "./events"
import { boundaryOf } from "./boundary"
import { agentsPackage } from "./spawn"

// createAgent is the front door: one hosted, spawn-capable agent over an
// ambient in-process host. No actor exists outside a host (the Erlang-node
// shape); the user brings packages and a mind, the graph is whatever
// their agent's code decides to spawn, and ask answers when the ROOT
// settles, however many lanes exist by then.

export interface CreateAgentOptions {
  readonly packages?: ReadonlyArray<Package>
  // The mind: one inference over the trajectory, one action out.
  readonly infer: (trajectory: ReadonlyArray<Envelope>, key?: string) => Promise<Action>
}

export interface HostedAgent {
  readonly ask: (brief: string) => Promise<{ readonly output?: string; readonly error?: string }>
  readonly host: Host
}

const ROOT = "ag.root"

export const createAgent = (options: CreateAgentOptions): HostedAgent => {
  const user = options.packages ?? []
  const infer = Layer.succeed(Infer, {
    react: (trajectory: ReadonlyArray<Envelope>, key?: string) => Effect.promise(() => options.infer(trajectory, key))
  })
  const tmp = memoryTmp()

  // The layers close over the host and are built per serve, so the
  // spawn package always routes and reads through the live host.
  const layersFor = (lane: string): Layer.Layer<AgentR> => {
    const self = host.self(lane)
    const router = {
      deliver: (address: string, event: Envelope) => Effect.sync(() => host.deliver(address, event)),
      call: () => Effect.succeed({ error: "escalatable spawns need a binding with synchronous calls" }),
      resume: () => Effect.succeed({ error: "escalatable spawns need a binding with synchronous calls" })
    }
    const spawn = agentsPackage(router, self, (callId) => host.self(`ag.${callId}`), {
      events: (facet: string) => Promise.resolve(host.read(facet))
    })
    const all = [...user, spawn]
    const packages = Layer.succeed(Packages, {
      resolve: (name: string) => all.find((p) => p.name === name),
      list: () => Effect.succeed(all.map((p) => ({ name: p.name, description: p.description })))
    })
    return Layer.mergeAll(packages, jsSandbox, tmp, infer, Layer.succeed(Router, router)) as unknown as Layer.Layer<AgentR>
  }

  // Every ag. lane runs the full turn loop; anything else is a sink.
  const host: Host = createHost<AgentR>({
    principal: "mem",
    actorFor: (lane) => (lane.startsWith("ag.") ? agent : undefined),
    layersFor: layersFor as never
  })

  let n = 0
  const ask = async (brief: string): Promise<{ readonly output?: string; readonly error?: string }> => {
    const id = `ask-${n++}`
    host.deliver(host.self(ROOT), { type: "MessageReceived", id, text: brief, at: n } as Envelope)
    await host.drive()
    const boundary = boundaryOf(host.read(ROOT), id)
    if (boundary === undefined) return { error: "the root never settled" }
    if (boundary.kind === "completed") return { output: boundary.output }
    if (boundary.kind === "failed") return { error: boundary.error }
    return { error: "the root parked on a budget ask with nobody to answer" }
  }

  return { ask, host }
}
