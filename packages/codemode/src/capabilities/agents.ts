import { Effect } from "effect"
import { Router, Self } from "@flamecast/core"
import { callAgent, type SubagentResult } from "@flamecast/harness"
import { capability } from "../capability"

// Delegation inside a script. This is where code mode earns its keep for multi-agent work: fan-out
// is `Promise.all` over `agents.call`, the join is the language's own await, and a retry or a
// deadline is an ordinary combinator. No gather protocol needs to exist, because the host language
// already has one.
//
// The call ids come from the script's evaluation order, so a script that runs twice asks the same
// questions and each child absorbs the repeat as a redelivery. That is what makes a re-run after a
// crash cheap: the children answer from their logs rather than working again.

export interface AgentsOptions {
  // The addresses a script may reach, as exact names or `prefix/*` patterns. Leaving this out
  // permits every address the router can resolve, so a deployment that runs model-written source
  // states the list.
  readonly allow?: ReadonlyArray<string>
  readonly summary?: string
}

const permitted = (allow: ReadonlyArray<string> | undefined, address: string) =>
  allow === undefined ||
  allow.some((pattern) =>
    pattern.endsWith("/*") ? address.startsWith(pattern.slice(0, -1)) : pattern === address
  )

export const agents = (options: AgentsOptions = {}) =>
  capability<Router | Self>({
    name: "agents",
    summary:
      options.summary ??
      [
        "Ask other agents. Each call runs in its own session and returns its own answer.",
        options.allow === undefined ? undefined : `Addresses: ${options.allow.join(", ")}.`,
        "Independent questions belong in one Promise.all."
      ]
        .filter((part) => part !== undefined)
        .join(" "),
    methods: [
      {
        name: "call",
        signature: "call(address, text, options?): Promise<{ output?, error?, usage }>",
        description:
          "Ask the agent at address. options.id names the question when the caller wants a stable id.",
        run: (args, at) =>
          Effect.gen(function* () {
            const address = String(args[0] ?? "")
            const text = String(args[1] ?? "")
            const given = (args[2] as { readonly id?: unknown } | undefined)?.id
            if (!permitted(options.allow, address)) {
              return {
                agent: address,
                turn: "",
                error: `the script may not reach "${address}"`,
                usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 }
              } satisfies SubagentResult
            }
            const session = yield* Self
            return yield* callAgent(address, {
              id: given === undefined ? `${at.execId}/${at.sequence}` : String(given),
              text,
              origin: { session, turn: at.turn, call: at.execId }
            })
          })
      }
    ]
  })
