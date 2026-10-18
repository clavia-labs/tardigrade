export interface Event { readonly key: string; readonly text: string; readonly remove: boolean; readonly delta: number }
export type State = { readonly document: { readonly count: number }; readonly messages: readonly string[]; readonly jobs: Readonly<Record<string, { readonly text: string }>> }

export const initialState = (): State => ({ document: { count: 0 }, messages: [], jobs: {} })

// reduceJson interprets immutable event prefixes independently of Grove's edit implementation (collections/history.ts).
export function reduceJson(state: State, event: Event): State {
  const jobs = { ...state.jobs }
  if (event.remove) delete jobs[event.key]
  else Object.defineProperty(jobs, event.key, { value: { text: event.text }, enumerable: true, configurable: true, writable: true })
  return { document: { count: state.document.count + event.delta }, messages: [...state.messages, event.text], jobs }
}
