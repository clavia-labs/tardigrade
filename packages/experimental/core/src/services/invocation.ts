import { Context, Effect, Schema } from "effect"
import { MessageMetadata, MessageSender, MessageReceipt, MessageAddress } from "../actor/message"
import { RuntimeError } from "../runtime/effects"
import { ThreadCoordinate } from "../actor/thread"
import { act } from "../atoms/act"
import type { Supervisor } from "./supervisor"

export const MessageDelivery = Schema.Struct({
  id: Schema.NonEmptyString, target: MessageAddress, body: Schema.Json,
  inReplyTo: Schema.optionalKey(Schema.NonEmptyString),
})
export type MessageDelivery = typeof MessageDelivery.Type

export const DeliverMessage = act({ name: "host.message.deliver", input: MessageDelivery, success: MessageReceipt, failure: Schema.String })

export const IncomingMessage = Schema.Struct({ target: ThreadCoordinate, body: Schema.Json, message: MessageMetadata })
export type IncomingMessage = typeof IncomingMessage.Type

export interface ActorMessageTransport {
  readonly deliver: (address: ThreadCoordinate, body: Schema.Json, metadata: MessageMetadata) => Effect.Effect<MessageReceipt, Error>
}

export interface MessageTransport {
  readonly deliver: (address: Schema.Json, body: Schema.Json, metadata: MessageMetadata) => Effect.Effect<MessageReceipt, Error>
}

export const DEFAULT_EXTERNAL_SENDER: MessageSender = { kind: "external", id: "host" }

// Invocation delivers actor inputs with host-established sender context and acknowledges journal acceptance.
export class Invocation extends Context.Service<Invocation, {
  readonly send: (message: MessageDelivery) => Effect.Effect<MessageReceipt, Error>
}>()("experimental/Invocation") {}

// createInvocation routes messages to registered threads; forSender binds the host-established calling identity.
export function createInvocation<Reference>(options: {
  readonly supervisor: typeof Supervisor.Service
  readonly reference: (coordinate: ThreadCoordinate) => Effect.Effect<Reference, Error>
  readonly receive: (coordinate: ThreadCoordinate, body: Schema.Json, metadata: MessageMetadata) => Effect.Effect<MessageReceipt, Error>
  readonly from: MessageSender
  readonly actorTransport?: ActorMessageTransport
  readonly transports?: Readonly<Record<string, MessageTransport>>
  readonly run: <Value>(work: Effect.Effect<Value, Error>) => Effect.Effect<Value, Error>
}) {
  const registered = (coordinate: ThreadCoordinate) => Effect.gen(function* () {
    const found = yield* options.supervisor.lookup(coordinate)
    return found ? yield* options.reference(found) : undefined
  })
  const receive = (input: IncomingMessage) => options.run(Effect.gen(function* () {
    const packet = yield* Schema.decodeEffect(IncomingMessage, { onExcessProperty: "error" })(input).pipe(Effect.mapError(RuntimeError.from))
    const target = yield* options.supervisor.lookup(packet.target)
    if (!target) return yield* Effect.fail(new RuntimeError(`Unknown thread: ${packet.target.thread}`))
    return yield* options.receive(target, packet.body, packet.message)
  }))
  const forSender = (sender: MessageSender): typeof Invocation.Service => {
    const from = Schema.decodeSync(MessageSender, { onExcessProperty: "error" })(sender)
    return {
      send: input => options.run(Effect.gen(function* () {
        const message = yield* Schema.decodeEffect(MessageDelivery, { onExcessProperty: "error" })(input).pipe(Effect.mapError(RuntimeError.from))
        const metadata = { id: message.id, from, ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}) }
        let receipt: MessageReceipt
        if (Schema.is(ThreadCoordinate)(message.target)) {
          receipt = yield* (options.actorTransport
            ? options.actorTransport.deliver(message.target, message.body, metadata)
            : receive({ target: message.target, body: message.body, message: metadata }))
        } else {
          const transport = options.transports?.[message.target.transport]
          if (!transport) return yield* Effect.fail(new RuntimeError(`Unknown message transport: ${message.target.transport}`))
          receipt = yield* transport.deliver(message.target.address, message.body, metadata)
        }
        const accepted = yield* Schema.decodeEffect(MessageReceipt, { onExcessProperty: "error" })(receipt).pipe(Effect.mapError(RuntimeError.from))
        if (accepted.id !== message.id) return yield* Effect.fail(new RuntimeError("Transport receipt identifies a different message"))
        return accepted
      })),
    }
  }
  return {
    ...forSender(options.from),
    forSender,
    receive,
    get: (coordinate: ThreadCoordinate) => options.run(registered(coordinate)),
  }
}
