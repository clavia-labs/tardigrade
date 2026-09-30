// runtimeCheckpoint models atomic checkpoint publication and crash recovery (visibleEquivalent).
// Two durable Boolean atoms share a journal cursor; a derived projection reads both.
// Storage commits atomically, codecs preserve state, and the actor is isolated from concurrent writers.
// Effect lifecycle admission, dynamic graph discovery, and TypeScript refinement are outside this model.
// The checked instance has three-event journals; induction covers arbitrary transition counts.
// Run verification in a temporary directory to keep checker artifacts outside the repository:
// runtime_model="$PWD/packages/experimental/core/quint/checkpoint/runtimeCheckpoint.qnt"
// verification_dir=$(mktemp -d /tmp/tardigrade-quint-runtime.XXXXXX)
// (cd "$verification_dir" && JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home quint verify "$runtime_model" --inductive-invariant=invariant --invariants checkpointSound visibleEquivalent)
module runtimeCheckpoint {
  type State = (bool, bool)
  pure val capacity = 3
  pure val events = Set(false, true)
  pure val states = tuples(events, events)
  pure val phases = Set("live", "prepared", "committed", "down", "recovering")
  pure val initial = (false, false)
  pure val histories = 1.to(capacity).fold(Set(List()), (prefixes, _) =>
    prefixes.union(prefixes.fold(Set(List()), (output, prefix) =>
      output.union(events.map(event => prefix.append(event))))))
  pure def reduce(state: State, event: bool): State = (state._1 != event, if (event) state._1 else state._2)
  pure def replay(history: List[bool]): State = history.foldl(initial, (state, event) => reduce(state, event))
  pure def graph(state: State): (bool, bool, bool) = (state._1, state._2, state._1 != state._2)

  var journal: List[bool]
  var checkpointPosition: int
  var checkpointState: State
  var phase: str
  var live: State
  var cursor: int
  var preparedState: State
  var batch: List[bool]
  var saveCheckpoint: bool

  type Frame = { journal: List[bool], checkpointPosition: int, checkpointState: State, phase: str, live: State, cursor: int, preparedState: State, batch: List[bool], saveCheckpoint: bool }
  val frame: Frame = { journal: journal, checkpointPosition: checkpointPosition, checkpointState: checkpointState, phase: phase, live: live, cursor: cursor, preparedState: preparedState, batch: batch, saveCheckpoint: saveCheckpoint }
  action update(after: Frame): bool = all {
    journal' = after.journal, checkpointPosition' = after.checkpointPosition, checkpointState' = after.checkpointState, phase' = after.phase, live' = after.live, cursor' = after.cursor, preparedState' = after.preparedState, batch' = after.batch, saveCheckpoint' = after.saveCheckpoint
  }

  action init = all {
    journal' = List(),
    checkpointPosition' = 0,
    checkpointState' = initial,
    phase' = "live",
    live' = initial,
    cursor' = 0,
    preparedState' = initial,
    batch' = List(),
    saveCheckpoint' = false,
  }

  action prepare = {
    nondet event = events.oneOf()
    nondet save = Set(false, true).oneOf()
    all {
      phase == "live", journal.length() < capacity,
      update(frame.with("phase", "prepared").with("preparedState", reduce(live, event)).with("batch", List(event)).with("saveCheckpoint", save)),
    }
  }

  action prepareCheckpoint = all {
    phase == "live",
    update(frame.with("phase", "prepared").with("preparedState", live).with("batch", List()).with("saveCheckpoint", true)),
  }

  // commit publishes the event batch and optional global checkpoint in one storage transition.
  action commit = all {
    phase == "prepared",
    update(frame.with("journal", journal.concat(batch)).with("checkpointPosition", if (saveCheckpoint) journal.length() + batch.length() else checkpointPosition).with("checkpointState", if (saveCheckpoint) preparedState else checkpointState).with("phase", "committed")),
  }

  action publish = all {
    phase == "committed",
    update(frame.with("phase", "live").with("live", preparedState).with("batch", List()).with("saveCheckpoint", false)),
  }

  // crash discards volatile preparation and live state while preserving committed storage.
  action crash = all {
    update(frame.with("phase", "down").with("live", initial).with("cursor", 0).with("preparedState", initial).with("batch", List()).with("saveCheckpoint", false)),
  }

  action restore = all {
    phase == "down",
    update(frame.with("phase", "recovering").with("live", checkpointState).with("cursor", checkpointPosition)),
  }

  action replayNext = all {
    phase == "recovering",
    cursor < journal.length(),
    update(frame.with("live", reduce(live, journal.nth(cursor))).with("cursor", cursor + 1)),
  }

  action expose = all {
    phase == "recovering",
    cursor == journal.length(),
    update(frame.with("phase", "live")),
  }

  action step = any { prepare, prepareCheckpoint, commit, publish, crash, restore, replayNext, expose }

  val checkpointSound = checkpointState == replay(journal.slice(0, checkpointPosition))
  val visibleEquivalent = (phase == "live" or phase == "prepared") implies graph(live) == graph(replay(journal))
  val invariant = all {
    journal.in(histories),
    checkpointPosition.in(0.to(capacity)), checkpointPosition <= journal.length(),
    checkpointState.in(states), live.in(states), preparedState.in(states),
    phase.in(phases), cursor.in(0.to(capacity)),
    batch.in(Set(List(), List(false), List(true))), saveCheckpoint.in(events),
    checkpointSound,
    visibleEquivalent,
    (phase == "prepared") implies all {
      journal.length() + batch.length() <= capacity,
      preparedState == replay(journal.concat(batch)),
    },
    (phase == "committed") implies preparedState == replay(journal),
    (phase == "recovering") implies all {
      checkpointPosition <= cursor, cursor <= journal.length(),
      live == replay(journal.slice(0, cursor)),
    },
  }
}
