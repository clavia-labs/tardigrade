export const BACKGROUND_TASK_OWNERS = ["host", "request"] as const

export type BackgroundTaskOwner = typeof BACKGROUND_TASK_OWNERS[number]

export const DEFAULT_BACKGROUND_TASK_OWNER: BackgroundTaskOwner = "host"

export const backgroundTaskOwnerOf = (
  raw: string | undefined,
  fallback: BackgroundTaskOwner = DEFAULT_BACKGROUND_TASK_OWNER
): BackgroundTaskOwner => {
  if (raw === undefined) return fallback
  if (raw === "host" || raw === "request") return raw
  throw new Error(`TARDIGRADE_BACKGROUND_TASK_OWNER must be "host" or "request", got ${JSON.stringify(raw)}`)
}

interface RequestLifetime {
  waitUntil(task: Promise<unknown>): void
}

// retainBackgroundTask assigns the task to the request when the host does not retain ongoing work after an RPC returns.
export const retainBackgroundTask = (
  scope: RequestLifetime,
  owner: BackgroundTaskOwner,
  task: Promise<unknown>
): void => {
  if (owner === "request") scope.waitUntil(task)
}
