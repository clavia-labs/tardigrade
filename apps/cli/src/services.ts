import { Context, Layer } from "effect"
import { makeClient, type Client, type ClientOptions } from "@clavia/tardigrade-client"
import { agentProjections } from "@clavia/tardigrade-server/actor"

import type { Env } from "./config"

// The two things a command reads that are not its own arguments: the environment it resolves
// configuration from, and the client it calls a server with. They are one service so that a test
// drives a real command tree against a client it wrote, with an environment it stated, and no
// process to spawn (commands.test.ts).

// The projections the command line reads. They are the served actor's own declaration, imported
// rather than restated, so `tdg` asks for exactly what the server mounts and gets it typed
// (apps/server/src/actor.ts, agentProjections).
export type CliProjections = typeof agentProjections

export interface CliServices {
  readonly env: Env
  readonly openClient: (options: ClientOptions<CliProjections>) => Client<CliProjections>
  // Where the invocation's message id comes from. A retried invocation carrying the same id is
  // absorbed by the server rather than started twice (docs/how-to/server.md, "Redelivery is
  // absorbed"), so the id is minted once per delivery and is stated in the help.
  readonly mintId: () => string
}

export class Cli extends Context.Service<Cli, CliServices>()("tardigrade/cli/Cli") {}

export const layerCli: Layer.Layer<Cli> = Layer.succeed(Cli)({
  env: process.env,
  openClient: (options) => makeClient({ ...options, projections: agentProjections }),
  mintId: () => crypto.randomUUID()
})
