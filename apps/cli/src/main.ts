#!/usr/bin/env bun
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { assertSupportedBun } from "@clavia/tardigrade-bun/runtime"

import { tdg } from "./commands"
import { layerCli } from "./services"
import { versionIn } from "./version"

// The entry point: arguments in, one command run, an exit code out. It holds no logic of its own,
// so everything worth testing lives in commands.ts, config.ts, or render.ts and is exercised
// without a process (commands.test.ts).

// The process refuses to run on a runtime the framework cannot keep its promises on, rather than
// failing later inside a turn (platform/bun/src/runtime.ts).
assertSupportedBun()

const version = await versionIn(import.meta.url)

Command.run(tdg, { version }).pipe(
  Effect.provide(Layer.mergeAll(BunServices.layer, layerCli)),
  BunRuntime.runMain
)
