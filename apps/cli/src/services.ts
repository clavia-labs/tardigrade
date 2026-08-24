import { Context, Layer } from "effect"
import { makeClient, type Client, type ClientOptions } from "@clavia/tardigrade-client"

import type { Env } from "./config"

// CliServices holds the process capabilities used by command handlers. Tests replace them to drive
// the command tree without network access or child processes (commands.test.ts).

export interface CliServices {
  readonly env: Env
  readonly cwd: string
  readonly openClient: (options: ClientOptions) => Client
  readonly installProject: (directory: string) => Promise<void>
  // mintId supplies the durable thread and call ids used when a caller states neither.
  readonly mintId: () => string
}

export class Cli extends Context.Service<Cli, CliServices>()("tardigrade/cli/Cli") {}

const installProject = async (directory: string): Promise<void> => {
  const child = Bun.spawn(["bun", "install"], {
    cwd: directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  if (code !== 0) throw new Error(`bun install exited ${code}: ${(stderr || stdout).trim()}`)
}

export const layerCli: Layer.Layer<Cli> = Layer.succeed(Cli)({
  env: process.env,
  cwd: process.cwd(),
  openClient: (options) => makeClient(options),
  installProject,
  mintId: () => crypto.randomUUID()
})
