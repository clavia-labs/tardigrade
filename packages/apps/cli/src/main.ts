#!/usr/bin/env bun
import { Effect } from "effect"
import { Command } from "effect/cli"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { cli } from "./commands"

Command.run(cli, { version: "0.0.1" }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
