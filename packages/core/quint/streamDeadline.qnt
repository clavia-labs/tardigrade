// streamDeadline checks first-chunk and idle deadlines without accepting partial output as completion (invariant, streamsEnd).
// Chunks reset the idle deadline; local interruption precedes failure and discards late chunks.
// Wire buffering, remote producer cancellation, retry recovery, and TypeScript refinement are outside this finite instance.
module streamDeadline {
  type State = { phase: str, time: int, last: int, deadline: int, firstMs: int, idleMs: int, chunks: int, ended: bool, bound: str }
  var state: State
  pure def initial(first: int, idle: int): State = { phase: "first", time: 0, last: 0, deadline: first, firstMs: first, idleMs: idle, chunks: 0, ended: false, bound: "" }
  action init = {
    nondet first = Set(1, 2).oneOf()
    nondet idle = Set(1, 2).oneOf()
    state' = initial(first, idle)
  }
  val active = state.phase.in(Set("first", "idle"))
  action tick = all { active, state.time < state.deadline, state' = state.with("time", state.time + 1) }
  action chunk = all {
    active, state.time < state.deadline, state.time <= 4, state.chunks < 2,
    state' = state.with("phase", "idle").with("chunks", state.chunks + 1).with("last", state.time).with("deadline", state.time + state.idleMs),
  }
  action expire = all {
    active, state.time >= state.deadline,
    state' = state.with("phase", "stopping").with("bound", if (state.phase == "first") "firstChunkMs" else "idleMs"),
  }
  action interrupt = all { state.phase == "stopping", state' = state.with("phase", "failed") }
  action finish = all { active, state.time < state.deadline, state' = state.with("phase", "done").with("ended", true) }
  action lateChunk = all { state.phase == "failed", state' = state }
  action hold = state' = state
  action step = any { tick, chunk, expire, interrupt, finish, lateChunk, hold }
  val deadlineReset = active implies state.deadline == state.last + (if (state.phase == "first") state.firstMs else state.idleMs)
  val successRequiresEnd = state.phase == "done" implies state.ended
  val timeoutIsFailure = state.bound != "" implies state.phase.in(Set("stopping", "failed")) and not(state.ended)
  val invariant = deadlineReset and successRequiresEnd and timeoutIsFailure and state.chunks.in(0.to(2))
  temporal fairDeadline = tick.weakFair(state) and expire.weakFair(state) and interrupt.weakFair(state)
  temporal streamsEnd = fairDeadline implies active.leadsTo(state.phase.in(Set("done", "failed")))
  action stepTimeoutCompletes = any { step, all { state.phase == "stopping", state' = state.with("phase", "done") } }
  action stepMissesReset = any { step, all {
    active, state.time < state.deadline, state.chunks < 2,
    state' = state.with("phase", "idle").with("chunks", state.chunks + 1).with("last", state.time),
  } }
  run firstChunkTimeoutTest = (state' = initial(1, 2)).then(tick).then(expire).then(interrupt)
    .expect(invariant and state.bound == "firstChunkMs" and state.chunks == 0)
  run idleTimeoutTest = (state' = initial(2, 1)).then(chunk).then(tick).then(expire).then(interrupt)
    .expect(invariant and state.bound == "idleMs" and state.chunks == 1 and not(state.ended))
  run chunksResetDeadlineTest = (state' = initial(2, 2)).then(tick).then(chunk).then(tick).then(chunk)
    .expect(invariant and state.time == 2 and state.deadline == 4).then(finish).expect(invariant)
  run lateChunkTest = (state' = initial(1, 2)).then(tick).then(expire).then(interrupt).then(lateChunk)
    .expect(invariant and state.chunks == 0 and state.phase == "failed")
}
