export const DEFAULT_ACTOR_INSTANCE = "main"
export const DEFAULT_API_URL = "http://localhost:4242"

const configured = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().replace(/\/$/, "") : undefined

export const actorInstance = (value: unknown = import.meta.env.VITE_ACTOR_ID): string =>
  configured(value) ?? DEFAULT_ACTOR_INSTANCE

export const apiUrl = (value: unknown = import.meta.env.VITE_API_URL): string =>
  configured(value) ?? DEFAULT_API_URL
