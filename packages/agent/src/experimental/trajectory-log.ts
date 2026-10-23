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

// immutableConversation validates and freezes a prepared context for reuse by act input decoding (platform/test/properties/turn-facts.ts, trajectoryWindowCache).
export function immutableConversation(messages: typeof Conversation.Type): typeof Conversation.Type {
  const value = messageValidator.parse(messages)
  if (value === invalid) throw new RuntimeError("Invalid projected conversation")
  return value as typeof Conversation.Type
}

// immutableMessage validates a detached message and records it as frozen plain data for request reuse (platform/test/properties/turn-facts.ts, trajectoryWindowCache).
export function immutableMessage(message: typeof Conversation.Type[number]): typeof Conversation.Type[number] {
  return immutableConversation(structuredClone([message]))[0]!
}
