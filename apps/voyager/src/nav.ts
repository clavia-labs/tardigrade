import { useCallback, useSyncExternalStore } from "react"

// The URL is the app's only navigation state. `?agent=` chooses the screen and `?from=` and `?to=`
// carry the window's two edges, so a view is shareable and survives a refresh (voyager-spec.md,
// "Conventions"). There is no routing library: three params and pushState are the whole of it.

// The params the app reads. Anything else in the query belongs to something other than navigation
// and is preserved untouched by `navigate`.
//
// The window's edges are fractions of the log's time span, 0 at the first event and 1 at the last.
// A fraction is what the handle is dragged to, so the URL states the position the reader chose
// rather than a seq the app would have to derive from it.
export interface Route {
  readonly agent: string | undefined
  readonly from: number | undefined
  readonly to: number | undefined
}

const fraction = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
}

const parse = (search: string): Route => {
  const params = new URLSearchParams(search)
  const agent = params.get("agent")
  return {
    agent: agent === null || agent.length === 0 ? undefined : agent,
    from: fraction(params.get("from")),
    to: fraction(params.get("to"))
  }
}

export const routeOf = (search: string): Route => parse(search)

// navigate writes the route into the URL and tells the subscribers. History gets one entry per
// agent change and none per drag step: moving a handle should not fill the back button.
export const navigate = (next: Partial<Route>, options: { readonly replace?: boolean } = {}): void => {
  const params = new URLSearchParams(location.search)
  const write = (name: string, value: string | number | undefined) => {
    if (value === undefined) params.delete(name)
    else params.set(name, String(value))
  }
  if ("agent" in next) write("agent", next.agent)
  if ("from" in next) write("from", next.from)
  if ("to" in next) write("to", next.to)
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
