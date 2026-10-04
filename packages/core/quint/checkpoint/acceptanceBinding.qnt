// acceptanceBinding models reference allocation and framework acceptance bindings (invariant).
// Two invocations share an atom, act, and input; a third uses another atom with the same act and input.
// Acceptance stores its originating domain event and assigned reference atomically in a framework receipt.
// Owner numbers abstract originating journal positions; they are absent from Ref and require no additional domain event.
// Checkpoints preserve receipt projections; suffix replay reconstructs bindings before exposing requests.
// Payload verification, publication timing, execution, settlement, and TypeScript refinement remain separate contracts.
// quint verify packages/core/quint/checkpoint/acceptanceBinding.qnt --backend tlc --invariant invariant
// stepSplitCommit, stepDropBindings, and stepSwapBindings must violate invariant.
module acceptanceBinding {
  type Ref = { seq: int, atom: str, act: str }
  type Entry = { owner: int, ref: Ref, receipt: bool }
  type Bindings = int -> Ref
  type State = {
    journal: List[Entry], staged: int, phase: str,
    live: Bindings, checkpoint: Bindings, checkpointPosition: int, cursor: int,
  }
  pure val owners = Set(0, 1, 2)
  pure val capacity = 4
  pure def reference(position: int, owner: int): Ref = {
    seq: position, atom: if (owner < 2) "notifier" else "other", act: "sendMessage",
  }
  pure def bindings(history: List[Entry], receiptsOnly: bool): Bindings = history.foldl(Map(), (result, entry) =>
    if (entry.owner >= 0 and (not(receiptsOnly) or entry.receipt)) result.put(entry.owner, entry.ref) else result)
  pure def accepted(history: List[Entry]): Bindings = bindings(history, false)
  pure def project(history: List[Entry]): Bindings = bindings(history, true)

  var state: State
  action init = state' = {
    journal: List(), staged: -1, phase: "live", live: Map(),
    checkpoint: Map(), checkpointPosition: 0, cursor: 0,
  }

  action prepare = {
    nondet owner = owners.oneOf()
    all {
      state.phase == "live", state.staged == -1, state.journal.length() < capacity,
      not(accepted(state.journal).keys().contains(owner)),
      state' = state.with("staged", owner),
    }
  }
  // abort leaves acceptance and domain bindings unchanged after a failed transaction.
  action abort = all {
    state.phase == "live", state.staged >= 0,
    state' = state.with("staged", -1),
  }
  action commitWithReceipt(atomic: bool): bool = all {
    state.phase == "live", state.staged >= 0, state.journal.length() < capacity,
    val ref = reference(state.journal.length(), state.staged)
    state' = state.with("journal", state.journal.append({ owner: state.staged, ref: ref, receipt: atomic }))
      .with("live", if (atomic) state.live.put(state.staged, ref) else state.live).with("staged", -1),
  }
  action commit = commitWithReceipt(true)
  // update advances journal position while a proposal can remain unaccepted.
  action update = all {
    state.phase == "live", state.journal.length() < capacity,
    state' = state.with("journal", state.journal.append({ owner: -1, ref: reference(0, 0), receipt: false })),
  }
  action captureWithBindings(retain: bool): bool = all {
    state.phase == "live",
    state' = state.with("checkpointPosition", state.journal.length())
      .with("checkpoint", if (retain) state.live else Map()),
  }
  action capture = captureWithBindings(true)
  action crash = all {
    state.phase == "live",
    state' = state.with("phase", "down").with("live", Map()).with("staged", -1).with("cursor", 0),
  }
  action restore = all {
    state.phase == "down",
    state' = state.with("phase", "replay").with("live", state.checkpoint).with("cursor", state.checkpointPosition),
  }
  action replayNext = all {
    state.phase == "replay", state.cursor < state.journal.length(),
    val entry = state.journal.nth(state.cursor)
    state' = state.with("live", if (entry.owner >= 0 and entry.receipt) state.live.put(entry.owner, entry.ref) else state.live)
      .with("cursor", state.cursor + 1),
  }
  action expose = all {
    state.phase == "replay", state.cursor == state.journal.length(),
    state' = state.with("phase", "live"),
  }
  // swapBindings represents recovery guessing between identical calls to the same operation.
  action swapBindings = all {
    state.phase == "live", Set(0, 1).subseteq(state.live.keys()),
    state' = state.with("live", state.live.put(0, state.live.get(1)).put(1, state.live.get(0))),
  }
  action step = any { prepare, abort, commit, update, capture, crash, restore, replayNext, expose }
  action stepSplitCommit = any { step, commitWithReceipt(false) }
  action stepDropBindings = any { step, captureWithBindings(false) }
  action stepSwapBindings = any { step, swapBindings }

  val requestPositions = state.journal.indices().filter(i => state.journal.nth(i).owner >= 0)
  val acceptanceIdentity = requestPositions.forall(i => state.journal.nth(i).ref == reference(i, state.journal.nth(i).owner))
  val uniqueReferences = requestPositions.forall(i => requestPositions.forall(j =>
    i == j or state.journal.nth(i).ref != state.journal.nth(j).ref))
  val acceptanceAtomic = project(state.journal) == accepted(state.journal)
  val checkpointBindings = state.checkpoint == project(state.journal.slice(0, state.checkpointPosition))
  val recoveryEquivalent = state.phase == "live" implies state.live == accepted(state.journal)
  val replayPrefix = state.phase == "replay" implies state.live == project(state.journal.slice(0, state.cursor))
  val invariant = all {
    acceptanceIdentity, uniqueReferences, acceptanceAtomic, checkpointBindings, recoveryEquivalent, replayPrefix,
  }
}
