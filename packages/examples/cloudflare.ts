/// <reference types="@cloudflare/workers-types" />

import { Layer } from "effect"
import { createActorWorker } from "@clavia/tardigrade-platform/cloudflare"

import { actor } from "./agents/inbox"

const worker = createActorWorker({ actor, services: () => Layer.empty })
export const ActorDO = worker.ActorObject
export const ThreadDO = worker.ThreadObject

export default {
  fetch: worker.fetch,
}
