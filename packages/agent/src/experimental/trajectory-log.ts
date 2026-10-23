import { Log } from "@clavia/tardigrade-core/experimental"
import { Context } from "effect"
import { EventLog, RuntimeError, type Getter } from "@clavia/tardigrade-core"
import { eventLogContext } from "@clavia/tardigrade-core/services/event-log"
import { incrementalValidator, invalid } from "@clavia/tardigrade-core/atoms/incremental/validate"
import { Conversation, Event } from "../contracts/events"

export const agentLog = Log.make({ schema: Event })

// trajectoryLog exposes chronological conversation events without materializing the trajectory array (platform/test/properties/turn-facts.ts).
export const trajectoryLog = agentLog.view(["TurnRequested", "ModelReturned", "ToolReturned"])

// trajectoryRevision identifies an append-only journal prefix for bounded window reuse (platform/test/properties/turn-facts.ts, trajectoryWindowCache).
export function trajectoryRevision(get: Getter) {
  const context = get(eventLogContext)
  if (!context) throw new RuntimeError("Missing EventLog service")
  const service = Context.get(context, EventLog)
  return { source: service.events, position: get(service.replay).position }
}

const messageValidator = incrementalValidator(Conversation)

// immutableMessage validates a detached message and records it as frozen plain data for request reuse (platform/test/properties/turn-facts.ts, trajectoryWindowCache).
export function immutableMessage(message: typeof Conversation.Type[number]): typeof Conversation.Type[number] {
  const value = messageValidator.parse(structuredClone([message]))
  if (value === invalid) throw new RuntimeError("Invalid projected conversation message")
  return (value as typeof Conversation.Type)[0]!
}
