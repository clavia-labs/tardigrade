export const DEFAULT_SUPERVISOR_PAGE_SIZE = 100

export interface SupervisorPageOptions {
  readonly after?: string
  readonly limit?: number
}
