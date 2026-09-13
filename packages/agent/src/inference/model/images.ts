import { Effect } from "effect"
import type { ImageStore } from "@clavia/tardigrade-core/interaction/image"
import { resolveImageSource } from "@clavia/tardigrade-core/interaction/image"
import type { AgentMessage } from "../../projection/messages"

// resolveMessageImages hydrates owned image references for a local provider binding.
export const resolveMessageImages = (
  messages: ReadonlyArray<AgentMessage>,
  store: typeof ImageStore.Service
): Effect.Effect<ReadonlyArray<AgentMessage>> => store.egress === "defer"
  ? Effect.succeed(messages)
  : Effect.forEach(messages, (message): Effect.Effect<AgentMessage> => {
      if (message.role !== "user" || !Array.isArray(message.content)) return Effect.succeed(message)
      return Effect.map(
        Effect.forEach(message.content, (part) => part.type === "input_image" && store.owns(part.image_url)
          ? Effect.map(resolveImageSource(part.image_url, store), (image_url) => ({ ...part, image_url }))
          : Effect.succeed(part)),
        (content): AgentMessage => ({ ...message, content })
      )
    })
