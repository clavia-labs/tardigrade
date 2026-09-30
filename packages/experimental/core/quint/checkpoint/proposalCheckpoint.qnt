// proposalCheckpoint models reference allocation at durable request acceptance (recoveryMatchesRequest, allocationAtomic).
// Journal entries are ordered; checkpoint positions count consumed entries and unaccepted proposals have no bound reference.
// The finite instance permits four journal entries; initEarly reproduces allocation during proposal discovery.
// Execution, settlement, callbacks, and TypeScript refinement are outside this model.
// quint run packages/experimental/core/quint/checkpoint/proposalCheckpoint.qnt --init initEarly --invariant recoveryMatchesRequest --max-steps 10 --max-samples 10000 --seed 1
// Run verification from a temporary directory; initEarly exposes a seven-transition counterexample.
// quint verify /absolute/path/to/proposalCheckpoint.qnt --invariants recoveryMatchesRequest allocationAtomic --max-steps 12
module proposalCheckpoint {
  type Ref = { seq: int, atom: str, tag: str }
  type Entry = { kind: str, ref: Ref }
  type State = {
    journal: List[Entry], checkpointPosition: int, checkpointQueued: bool,
    phase: str, queued: bool, proposal: Ref, bound: bool, cursor: int, accepted: bool, mismatch: bool,
    allocationAtAcceptance: bool,
  }
  pure val capacity = 4
  pure def reference(seq: int): Ref = { seq: seq, atom: "delivery/send", tag: "hello" }
  pure def domain(kind: str): Entry = { kind: kind, ref: reference(0) }

  var state: State

  pure def initial(atAcceptance: bool): State = {
    journal: List(), checkpointPosition: -1, checkpointQueued: false,
    phase: "live", queued: false, proposal: reference(0), bound: false, cursor: 0, accepted: false, mismatch: false,
    allocationAtAcceptance: atAcceptance,
  }
  action init = state' = initial(true)
  action initEarly = state' = initial(false)

  action queue = all {
    state.phase == "live", not(state.queued), state.journal.length() < capacity,
    state' = state.with("journal", state.journal.append(domain("MessageQueued")))
      .with("queued", true).with("bound", not(state.allocationAtAcceptance))
      .with("proposal", reference(if (state.allocationAtAcceptance) 0 else state.journal.length() + 1)),
  }

  action update = all {
    state.phase == "live", state.queued, not(state.accepted), state.journal.length() < capacity,
    state' = state.with("journal", state.journal.append(domain("SettingsChanged"))),
  }

  // capture saves domain state at the global position without proposal bindings.
  action capture = all {
    state.phase == "live", state.queued, not(state.accepted),
    state' = state.with("checkpointPosition", state.journal.length()).with("checkpointQueued", state.queued),
  }

  action accept = all {
    state.phase == "live", state.queued, not(state.accepted), state.journal.length() < capacity,
    val ref = if (state.allocationAtAcceptance) reference(state.journal.length()) else state.proposal
    state' = state.with("journal", state.journal.append({ kind: "EffectRequested", ref: ref }))
      .with("accepted", true).with("bound", true).with("proposal", ref),
  }

  action crash = all {
    state.phase == "live", state.checkpointPosition >= 0,
    state' = state.with("phase", "down").with("queued", false)
      .with("proposal", reference(0)).with("bound", false).with("accepted", false).with("cursor", 0),
  }

  // restore reconstructs an unbound proposal; initEarly instead allocates at the checkpoint position.
  action restore = all {
    state.phase == "down",
    state' = state.with("phase", "replaying").with("queued", state.checkpointQueued)
      .with("proposal", reference(if (state.allocationAtAcceptance) 0 else state.checkpointPosition))
      .with("bound", not(state.allocationAtAcceptance)).with("cursor", state.checkpointPosition),
  }

  action replayNext = all {
    state.phase == "replaying", state.cursor < state.journal.length(),
    val entry = state.journal.nth(state.cursor)
    val expected = if (state.allocationAtAcceptance) reference(state.cursor) else state.proposal
    val mismatch = entry.kind == "EffectRequested" and entry.ref != expected
    val accepted = entry.kind == "EffectRequested" and not(mismatch)
    state' = state.with("cursor", state.cursor + 1).with("mismatch", mismatch)
      .with("accepted", accepted).with("bound", if (accepted) true else state.bound)
      .with("proposal", if (accepted) entry.ref else state.proposal)
      .with("phase", if (mismatch) "rejected" else "replaying"),
  }

  action step = any { queue, update, capture, accept, crash, restore, replayNext }
  val recoveryMatchesRequest = not(state.mismatch)
  val allocationAtomic = state.allocationAtAcceptance implies state.bound == state.accepted
}
