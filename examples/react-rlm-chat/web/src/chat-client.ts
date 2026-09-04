import { makeActorClient } from "@clavia/tardigrade-client"
import { agentMethods } from "tardie"

import { actorInstance, apiUrl } from "./config"

export const actor = actorInstance()
export const client = makeActorClient({ baseUrl: apiUrl(), methods: agentMethods })
