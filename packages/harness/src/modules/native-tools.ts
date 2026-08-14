import { Cause, Clock, Effect, Exit } from "effect"
import { erase, machine, type Event } from "@flamecast/core"
import { EXITS } from "../exits"
import type { NativeTool } from "../infer"
import { defineModule } from "../module"
import { turnView } from "../turns"
import { budgetSpent } from "./budget"

interface Call {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly turn: string
}

const callOf = (context: Partial<Call>): Call => {
  if (context.callId === undefined) {
    throw new Error("the native-tools machine is dispatching with no call in context")
  }
  return context as Call
}

const claimable = (log: ReadonlyArray<Event>): boolean => {
  const call = log[log.length - 1]
  return call !== undefined && !EXITS.has(String(call.name ?? ""))
}

const WALL_REFUSAL =
  "Tool budget reached. Do not call this tool again. Answer now with your best result from what " +
  "you have already gathered."

const nativeToolsMachine = <R>(handlers: ReadonlyMap<string, NativeTool<R>>) =>
  machine({
    id: "native-tools",
    view: turnView,
    initial: "idle",
    context: {} as Partial<Call>,
    states: {
      idle: {
        on: {
          ToolCalled: {
            target: "dispatching",
            when: claimable,
            assign: (_, event) => ({
              callId: String(event.callId ?? ""),
              name: String(event.name ?? ""),
              arguments: event.arguments,
              turn: String(event.turn ?? "")
            })
          }
        }
      },
      dispatching: {
        act: (log, context) =>
          Effect.gen(function* () {
            const call = callOf(context)
            const answer = (result: unknown, error?: string) => [
              {
                type: "ToolReturned",
                turn: call.turn,
                callId: call.callId,
                name: call.name,
                result,
                ...(error === undefined ? {} : { error })
              }
            ]
            const at = yield* Clock.currentTimeMillis
            const stamped = (events: ReadonlyArray<Event>) =>
              events.map((event) => ({ ...event, at }))
            if (budgetSpent(log)) return stamped(answer(null, WALL_REFUSAL))
            const tool = handlers.get(call.name)
            if (tool === undefined) return stamped(answer(null, `unknown tool: ${call.name}`))
            const outcome = yield* Effect.exit(
              tool.run(call.arguments, { turn: call.turn, callId: call.callId })
            )
            return stamped(
              Exit.isSuccess(outcome)
                ? answer(outcome.value)
                : answer(null, Cause.pretty(outcome.cause))
            )
          }),
        on: { ToolReturned: "idle" }
      }
    }
  })

export const nativeTools = <R = never>(list: ReadonlyArray<NativeTool<R>>) => {
  const handlers = new Map(list.map((tool) => [tool.spec.name, tool]))
  return defineModule({
    id: "native-tools",
    version: "2",
    identity: list.map((tool) => tool.spec),
    setup: () => ({
      events: ["ToolCalled", "ToolReturned"],
      machines: [erase(nativeToolsMachine(handlers))],
      nativeTools: list.map((tool) => tool.spec)
    })
  })
}

