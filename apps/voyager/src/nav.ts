import { useCallback, useSyncExternalStore } from "react"

// The URL is the app's only navigation state. `?agent=` chooses the screen and `?at=` the scrub
// position, so a view is shareable and survives a refresh (voyager-spec.md, "Conventions"). There
// is no routing library: two params and pushState are the whole of it.

// The params the app reads. Anything else in the query belongs to something other than navigation
// and is preserved untouched by `navigate`.
export interface Route {
  readonly agent: string | undefined
  readonly at: number | undefined
}

const parse = (search: string): Route => {
  const params = new URLSearchParams(search)
  const agent = params.get("agent")
  const at = params.get("at")
  const seq = at === null ? Number.NaN : Number(at)
  return {
    agent: agent === null || agent.length === 0 ? undefined : agent,
    at: Number.isInteger(seq) && seq >= 0 ? seq : undefined
  }
}

export const routeOf = (search: string): Route => parse(search)

// navigate writes the route into the URL and tells the subscribers. History gets one entry per
// agent change and none per scrub step: dragging a slider should not fill the back button.
export const navigate = (next: Partial<Route>, options: { readonly replace?: boolean } = {}): void => {
  const params = new URLSearchParams(location.search)
  const write = (name: string, value: string | number | undefined) => {
    if (value === undefined) params.delete(name)
    else params.set(name, String(value))
  }
  if ("agent" in next) write("agent", next.agent)
  if ("at" in next) write("at", next.at)
  const search = params.toString()
  const href = `${location.pathname}${search.length === 0 ? "" : `?${search}`}`
  if (options.replace === true) history.replaceState(null, "", href)
  else history.pushState(null, "", href)
  dispatchEvent(new PopStateEvent("popstate"))
}

const subscribe = (onChange: () => void): (() => void) => {
  addEventListener("popstate", onChange)
  return () => removeEventListener("popstate", onChange)
}

// useRoute re-renders on a back button press and on every `navigate`, which dispatches the same
// event the browser does so both paths take one code path.
export const useRoute = (): Route => {
  const snapshot = useCallback(() => location.search, [])
  return routeOf(useSyncExternalStore(subscribe, snapshot, () => ""))
}
