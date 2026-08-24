import { Context, Layer } from "effect"
import { makeClient, type Client, type ClientOptions } from "@clavia/tardigrade-client"

import type { Env } from "./config"

// The two things a command reads that are not its own arguments: the environment it resolves
// configuration from, and the client it calls a server with. They are one service so that a test
// drives a real command tree against a client it wrote, with an environment it stated, and no
// process to spawn (commands.test.ts).

export interface CliServices {
  readonly env: Env
  readonly cwd: string
  readonly openClient: (options: ClientOptions) => Client
  // mintId supplies the durable thread and call ids used when a caller states neither.
  readonly mintId: () => string
}

export class Cli extends Context.Service<Cli, CliServices>()("tardigrade/cli/Cli") {}

export const layerCli: Layer.Layer<Cli> = Layer.succeed(Cli)({
  env: process.env,
  cwd: process.cwd(),
  openClient: (options) => makeClient(options),
  mintId: () => crypto.randomUUID()
})
