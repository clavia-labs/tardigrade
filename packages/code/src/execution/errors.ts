import { Data } from "effect"

// Park is the signal a package method fails with when it awaits a reply that has not landed on
// the thread yet. The raisers are the awaiting methods: `tasks.fire`, `tasks.result`,
// `agents.run`, and `agents.result`. Park stays host-side: the proxy layer in `execute.ts`
// catches it, the body sees a promise that never settles, and the executor parks the whole
// execution. A code body can never observe or catch a park (park.test.ts, "a try/catch around
// the fire cannot observe the park").
// `awaiting` is the reply id whose arrival unblocks the call. The raiser knows the id because
// it delivered the brief the reply answers. The executor records it as
// `BlockedOn { callId, awaiting }`, so the derivation reads the awaited id from the log.
export class Park extends Data.TaggedError("Park")<{ readonly callId: string; readonly awaiting: string }> {}
