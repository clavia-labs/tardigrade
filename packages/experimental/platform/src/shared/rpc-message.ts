import { Effect } from "effect"
import { RuntimeError, type MessageReceipt, type ThreadCoordinate } from "@clavia/tardigrade-experimental-core"
import type { ActorMessageTransport, IncomingMessage } from "@clavia/tardigrade-experimental-core"

export interface ActorReceiver {
  readonly receive: (message: IncomingMessage) => Promise<MessageReceipt>
}

// rpcMessageTransport resolves actor receivers and acknowledges their receiving journal commits.
export function rpcMessageTransport(options: {
  readonly resolve: (address: ThreadCoordinate) => Effect.Effect<ActorReceiver, Error>
}): ActorMessageTransport {
  return {
    deliver: (target, body, message) => Effect.gen(function* () {
      const receiver = yield* options.resolve(target)
      return yield* Effect.tryPromise({ try: () => receiver.receive({ target, body, message }), catch: RuntimeError.from })
    }),
  }
}
