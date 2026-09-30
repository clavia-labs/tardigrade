// lazyAtomCheckpoint models first-read initialization from a seed or retained journal prefix (readyEquivalent).
// Journal prefixes remain available, reads eventually succeed, codecs preserve state, and reducers are deterministic.
// Appends may interleave with prefix loading and suffix reduction; an atom becomes visible only after catching up.
// The finite instance contains three-event journals and one atom; TypeScript refinement is outside this model.
// initSkipPrefix models restoring an omitted atom from its initial state at the checkpoint position.
// Apalache checks invariant initialization, preservation, and implication; TLC checks initializationProgress with initRecovery and stableStep.
// Run backend checks from a temporary directory so generated artifacts stay outside the repository.
// quint verify /absolute/path/to/lazyAtomCheckpoint.qnt --inductive-invariant invariant --invariants checkpointSound readyEquivalent progressDecreases
// quint verify /absolute/path/to/lazyAtomCheckpoint.qnt --backend tlc --init initRecovery --step stableStep --invariant invariant --temporal initializationProgress
// quint run /absolute/path/to/lazyAtomCheckpoint.qnt --init initSkipPrefix --invariant readyEquivalent --max-steps 20 --max-samples 10000 --seed 1
module lazyAtomCheckpoint {
  type State = {
    journal: List[int], checkpointPosition: int, seeded: bool, checkpointState: int,
    phase: str, cursor: int, value: int, fallback: bool,
    progress: bool, priorRank: int,
  }
  pure val capacity = 3
  pure val events = Set(-1, 0, 1)
  pure val phases = Set("unread", "idle", "loading", "replaying", "ready", "down")
  pure val histories = 1.to(capacity).fold(Set(List()), (prefixes, _) =>
    prefixes.union(prefixes.fold(Set(List()), (output, prefix) =>
      output.union(events.map(event => prefix.append(event))))))
  pure def reduce(value: int, event: int): int = value * 2 + event
  pure def replay(history: List[int]): int = history.foldl(0, (value, event) => reduce(value, event))
  pure def rank(s: State): int = if (s.phase == "loading") capacity + 2
    else if (s.phase == "replaying") capacity - s.cursor + 1 else 0

  var journal: List[int]
  var checkpointPosition: int
  var seeded: bool
  var checkpointState: int
  var phase: str
  var cursor: int
  var value: int
  var fallback: bool
  var progress: bool
  var priorRank: int
  val state: State = { journal: journal, checkpointPosition: checkpointPosition, seeded: seeded, checkpointState: checkpointState, phase: phase, cursor: cursor, value: value, fallback: fallback, progress: progress, priorRank: priorRank }
  action update(after: State): bool = all {
    journal' = after.journal, checkpointPosition' = after.checkpointPosition, seeded' = after.seeded, checkpointState' = after.checkpointState, phase' = after.phase, cursor' = after.cursor, value' = after.value, fallback' = after.fallback, progress' = after.progress, priorRank' = after.priorRank
  }

  pure def initial(fallback: bool): State = {
    journal: List(), checkpointPosition: 0, seeded: false, checkpointState: 0,
    phase: "unread", cursor: 0, value: 0, fallback: fallback, progress: false, priorRank: 0,
  }
  action init = {
    val after = initial(true)
    all { journal' = after.journal, checkpointPosition' = after.checkpointPosition, seeded' = after.seeded, checkpointState' = after.checkpointState, phase' = after.phase, cursor' = after.cursor, value' = after.value, fallback' = after.fallback, progress' = after.progress, priorRank' = after.priorRank }
  }
  action initSkipPrefix = {
    val after = initial(false)
    all { journal' = after.journal, checkpointPosition' = after.checkpointPosition, seeded' = after.seeded, checkpointState' = after.checkpointState, phase' = after.phase, cursor' = after.cursor, value' = after.value, fallback' = after.fallback, progress' = after.progress, priorRank' = after.priorRank }
  }

  // initRecovery starts after reopening an arbitrary committed prefix, with or without an atom seed.
  action initRecovery = {
    nondet history = histories.oneOf()
    nondet position = 0.to(history.length()).oneOf()
    nondet hasSeed = Set(false, true).oneOf()
    all {
      journal' = history, checkpointPosition' = position, seeded' = hasSeed,
      checkpointState' = if (hasSeed) replay(history.slice(0, position)) else 0,
      phase' = "idle", cursor' = 0, value' = 0, fallback' = true,
      progress' = false, priorRank' = 0,
    }
  }

  action commitEvent = {
    nondet event = events.oneOf()
    all {
      state.phase != "down", state.journal.length() < capacity,
      update(state.with("journal", state.journal.append(event))
        .with("cursor", if (state.phase == "ready") state.cursor + 1 else state.cursor)
        .with("value", if (state.phase == "ready") reduce(state.value, event) else state.value)
        .with("progress", false)),
    }
  }

  // capture may omit an unread atom while retaining the journal needed for first-read initialization.
  action capture = all {
    state.phase == "unread" or state.phase == "idle" or state.phase == "ready",
    update(state.with("checkpointPosition", state.journal.length())
      .with("seeded", state.phase == "ready")
      .with("checkpointState", if (state.phase == "ready") state.value else 0)
      .with("progress", false)),
  }

  action crash = all {
    state.phase != "down",
    update(state.with("phase", "down").with("cursor", 0).with("value", 0).with("progress", false)),
  }

  action restore = all {
    state.phase == "down",
    update(state.with("phase", "idle").with("progress", false)),
  }

  // read starts initialization without publishing the initial value of an omitted atom.
  action read = all {
    state.phase == "unread" or state.phase == "idle",
    update(state.with("phase", if (state.phase == "unread") "loading" else if (state.seeded or not(state.fallback)) "replaying" else "loading")
      .with("cursor", if (state.phase == "unread") 0 else if (state.seeded or not(state.fallback)) state.checkpointPosition else 0)
      .with("value", if (state.phase == "unread") 0 else if (state.seeded) state.checkpointState else 0)
      .with("progress", false)),
  }

  // prefixLoaded reduces the immutable checkpoint prefix; concurrent appends remain in the suffix.
  action prefixLoaded = all {
    state.phase == "loading",
    update(state.with("phase", "replaying").with("cursor", state.checkpointPosition)
      .with("value", replay(state.journal.slice(0, state.checkpointPosition)))
      .with("progress", true).with("priorRank", rank(state))),
  }

  action replayNext = all {
    state.phase == "replaying", state.cursor < state.journal.length(),
    update(state.with("cursor", state.cursor + 1)
      .with("value", reduce(state.value, state.journal.nth(state.cursor)))
      .with("progress", true).with("priorRank", rank(state))),
  }

  // publish makes state visible only when its cursor reaches the current committed journal length.
  action publish = all {
    state.phase == "replaying", state.cursor == state.journal.length(),
    update(state.with("phase", "ready").with("progress", true).with("priorRank", rank(state))),
  }

  action recoveryStep = any { prefixLoaded, replayNext, publish }
  action stutter = update(state.with("progress", false))
  action step = any { commitEvent, capture, crash, restore, read, recoveryStep, stutter }
  // stableStep excludes further crashes so successful journal reads and fair recovery scheduling can complete initialization.
  action stableStep = any { commitEvent, capture, read, recoveryStep, stutter }

  val checkpointSound = state.seeded implies state.checkpointState == replay(state.journal.slice(0, state.checkpointPosition))
  val readyEquivalent = state.phase == "ready" implies all {
    state.cursor == state.journal.length(), state.value == replay(state.journal),
  }
  val progressDecreases = state.progress implies rank(state) < state.priorRank
  val invariant = all {
    journal.in(histories), phase.in(phases),
    checkpointPosition.in(0.to(capacity)), checkpointPosition <= journal.length(),
    cursor.in(0.to(capacity)), cursor <= journal.length(),
    value.in((-7).to(7)), checkpointState.in((-7).to(7)),
    priorRank.in(0.to(capacity + 2)),
    seeded.in(Set(false, true)), fallback == true, progress.in(Set(false, true)),
    checkpointSound, readyEquivalent, progressDecreases,
    phase == "replaying" implies all {
      checkpointPosition <= cursor,
      value == replay(journal.slice(0, cursor)),
    },
    (phase == "unread" or phase == "idle" or phase == "loading" or phase == "down") implies all {
      cursor == 0, value == 0,
    },
  }
  temporal initializationProgress = recoveryStep.weakFair(state) implies
    (state.phase == "loading" or state.phase == "replaying").leadsTo(state.phase == "ready")
}
