// The two tool names the framework owns.
//
// A turn's exits are not work: the model calls `answer` to finish and `request-budget` to ask for
// more room. The contract module serves the first and the budget module serves the second, so the
// tools module must not dispatch either one, and neither draws the tool budget down. The names sit
// in one file so the three modules agree without importing each other's machinery.
//
// `request-budget` uses the spelling exposed to the model and event log.

export const ANSWER = "answer"
export const REQUEST_BUDGET = "request-budget"

export const EXITS: ReadonlySet<string> = new Set([ANSWER, REQUEST_BUDGET])
