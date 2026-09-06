// DEFAULT_ONBOARDING_BRIEF is the first message suggested for the quickstart template.
export const DEFAULT_ONBOARDING_BRIEF = "What is the weather in Singapore?"

// RLM_ONBOARDING_BRIEF is a delegation task supported by the RLM template.
export const RLM_ONBOARDING_BRIEF = "Create a child agent and ask it to fetch a fun fact about recursion."

// shellWord quotes a generated shell argument when spaces or shell punctuation make a bare word unsafe (workflow.test.ts).
export const shellWord = (value: string): string =>
  /^[A-Za-z0-9_./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`

// callCommand renders the local quickstart command with its method input stated (workflow.test.ts).
export const callCommand = (
  brief: string = DEFAULT_ONBOARDING_BRIEF
): string => `tdg call message ${shellWord(JSON.stringify({ text: brief }))} --thread main`
