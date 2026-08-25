// DEFAULT_ONBOARDING_BRIEF is the first message suggested after an actor is pushed.
export const DEFAULT_ONBOARDING_BRIEF = "Read this repository and tell me what it does"

// shellWord quotes a generated shell argument when spaces or shell punctuation make a bare word unsafe (workflow.test.ts).
export const shellWord = (value: string): string =>
  /^[A-Za-z0-9_./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`

// callCommand renders the local quickstart command with its method input stated (workflow.test.ts).
export const callCommand = (
  brief: string = DEFAULT_ONBOARDING_BRIEF
): string => `tdg call message ${shellWord(JSON.stringify({ text: brief }))}`

// traceUrlFor selects the thread in the Voyager served at the API origin (apps/voyager/src/nav.ts, Route).
export const traceUrlFor = (baseUrl: string, thread: string): string => {
  const url = new URL(baseUrl)
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  url.searchParams.set("thread", thread)
  return url.toString()
}
