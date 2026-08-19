// Package ids holds the code lane's id grammar: what the executor mints and what a reply
// answers to. RUN_PREFIX matches the product's run ids (apps/api/src/grammar/grammar.ts
// re-exports these, so the two grammars cannot drift).

// mintedRunId names a child run by the awaiting call's id under the run prefix, so a replayed
// fire lands on the same lane and the keyed fire absorbs the duplicate.
export const RUN_PREFIX = "run-"
export const mintedRunId = (mint: string): string => `${RUN_PREFIX}${mint}`

// callId keys a call's recorded pair as {execId}.{n} in execution order, so a re-run of the
// same body lands on the same keys.
export const callId = (execId: string, n: number): string => `${execId}.${n}`

// replyId and REPLY_SUFFIX come from core: a reply answers any actor, code or agent alike.
export { REPLY_SUFFIX, replyId } from "@clavia/tardigrade-core/reply"
