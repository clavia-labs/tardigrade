// runtimeCheckpoint models candidate preparation, atomic storage, publication, rollback, and record release (invariant).
// Memory holds fixed-size runtime frames and a batch of at most two records; the journal is persisted history.
// Runtime frames include active work; checkpoints contain durable actor state and require no active work.
// Settlement and its domain callback share a batch; reducers are deterministic and codecs preserve state.
// A failed acknowledgement may follow durable commit; both failure paths require recovery before further preparation.
// release does not require a checkpoint or completion of active work (publicationReleased).
// The finite instance has four-entry journals, two Boolean roots, and at most one active reference.
// Lazy atom discovery, external execution, cleanup payloads, byte allocation, and TypeScript refinement are outside this model.
// stableStep excludes further crashes; progress assumes fair record release and successful, fairly scheduled journal recovery.
// Negative initializers isolate early publication, failed rollback, retained history, partial commits, lost work, and checkpoint-gated release.
// Run checker artifacts outside the repository:
// quint test /absolute/path/to/runtimeCheckpoint.qnt
// quint verify /absolute/path/to/runtimeCheckpoint.qnt --backend tlc --invariant invariant
// quint verify /absolute/path/to/runtimeCheckpoint.qnt --backend tlc --init initRecovery --step stableStep --invariant invariant --temporal publicationReleased,recoveryProgress
module runtimeCheckpoint {
  type ActorState = (bool, bool)
  type Entry = { kind: str, value: bool }
  type RuntimeFrame = { position: int, actor: ActorState, activeRef: int }
  type Checkpoint = { position: int, actor: ActorState }
  type Faults = { earlyPublication: bool, failedRollback: bool, retainedHistory: bool, partialCommit: bool, lostWork: bool, checkpointRelease: bool }
  type State = {
    journal: List[Entry], checkpoint: Checkpoint, phase: str,
    live: RuntimeFrame, base: RuntimeFrame, baseCheckpoint: Checkpoint, candidate: RuntimeFrame,
    batch: List[Entry], archive: List[Entry], save: bool, aborted: bool, faults: Faults,
  }
  pure val capacity = 4
  pure val maxBatch = 2
  pure val emptyFrame: RuntimeFrame = { position: 0, actor: (false, false), activeRef: -1 }
  pure val emptyCheckpoint: Checkpoint = { position: 0, actor: (false, false) }
  pure val noFaults: Faults = { earlyPublication: false, failedRollback: false, retainedHistory: false, partialCommit: false, lostWork: false, checkpointRelease: false }
  pure val accept: Entry = { kind: "accept", value: false }
  pure val settle: Entry = { kind: "settle", value: false }
  pure def domain(value: bool): Entry = { kind: "domain", value: value }
  pure val batches = Set(List(accept), List(domain(false)), List(domain(true)), List(settle, domain(false)), List(settle, domain(true)))
  pure val phases = Set("live", "prepared", "committed", "published", "failed", "down", "recovering")
  pure def quiet(frame: RuntimeFrame): bool = frame.activeRef == -1
  pure def graph(actor: ActorState): (bool, bool, bool) = (actor._1, actor._2, actor._1 != actor._2)
  pure def reduce(frame: RuntimeFrame, entry: Entry): RuntimeFrame = {
    position: frame.position + 1,
    actor: if (entry.kind == "domain") (frame.actor._1 != entry.value, if (entry.value) frame.actor._1 else frame.actor._2) else frame.actor,
    activeRef: if (entry.kind == "accept") frame.position else if (entry.kind == "settle") -1 else frame.activeRef,
  }
  pure def foldFrame(frame: RuntimeFrame, records: List[Entry]): RuntimeFrame = records.foldl(frame, (current, entry) => reduce(current, entry))
  pure def replay(history: List[Entry]): RuntimeFrame = foldFrame(emptyFrame, history)
  pure def allowed(frame: RuntimeFrame, records: List[Entry]): bool =
    records.nth(0).kind == "domain" or (records.nth(0).kind == "accept" and quiet(frame)) or (records.nth(0).kind == "settle" and not(quiet(frame)))
  pure val histories = 1.to(capacity).fold(Set(List()), (prefixes, _) =>
    prefixes.union(prefixes.fold(Set(List()), (output, prefix) =>
      output.union(batches.filter(records => prefix.length() + records.length() <= capacity and allowed(replay(prefix), records)).map(records => prefix.concat(records))))))
  pure def initial(faults: Faults): State = {
    journal: List(), checkpoint: emptyCheckpoint, phase: "live",
    live: emptyFrame, base: emptyFrame, baseCheckpoint: emptyCheckpoint, candidate: emptyFrame,
    batch: List(), archive: List(), save: false, aborted: false, faults: faults,
  }
  var state: State
  action init = state' = initial(noFaults)
  action initEarlyPublication = state' = initial(noFaults.with("earlyPublication", true))
  action initFailedRollback = state' = initial(noFaults.with("failedRollback", true))
  action initRetainedHistory = state' = initial(noFaults.with("retainedHistory", true))
  action initPartialCommit = state' = initial(noFaults.with("partialCommit", true))
  action initLostWork = state' = initial(noFaults.with("lostWork", true))
  action initCheckpointRelease = state' = initial(noFaults.with("checkpointRelease", true))
  action initRecovery = {
    nondet history = histories.oneOf()
    nondet position = 0.to(history.length()).oneOf()
    val prefix = history.slice(0, position)
    all {
      prefix.in(histories), quiet(replay(prefix)),
      state' = initial(noFaults).with("journal", history).with("checkpoint", { position: position, actor: replay(prefix).actor }).with("phase", "down"),
    }
  }

  // prepareBatch keeps the committed frame visible while constructing the next frame and its optional checkpoint.
  action prepareBatch(records: List[Entry], save: bool): bool = {
    val candidate = foldFrame(state.live, records)
    all {
      state.phase == "live", records.in(batches), allowed(state.live, records),
      state.journal.length() + records.length() <= capacity, not(save) or quiet(candidate),
      state' = state.with("phase", "prepared").with("base", state.live).with("baseCheckpoint", state.checkpoint)
        .with("candidate", candidate).with("batch", records).with("save", save).with("aborted", false)
        .with("live", if (state.faults.earlyPublication) candidate else state.live),
    }
  }
  action prepare = {
    nondet records = batches.oneOf()
    nondet save = Set(false, true).oneOf()
    prepareBatch(records, save)
  }
  action prepareCheckpoint = all {
    state.phase == "live", quiet(state.live),
    state' = state.with("phase", "prepared").with("base", state.live).with("baseCheckpoint", state.checkpoint)
      .with("candidate", state.live).with("batch", List()).with("save", true).with("aborted", false),
  }

  // commit persists the complete batch and optional actor checkpoint before publication.
  action commit = {
    val records = if (state.faults.partialCommit and state.batch.length() == 2) List(state.batch.nth(0)) else state.batch
    all {
      state.phase == "prepared",
      state' = state.with("phase", "committed").with("journal", state.journal.concat(records))
        .with("checkpoint", if (state.save) { position: state.candidate.position, actor: state.candidate.actor } else state.checkpoint),
    }
  }
  action publish = all {
    state.phase == "committed",
    state' = state.with("phase", "published").with("live", state.candidate),
  }
  // release drops the committed batch and previous frame without changing the checkpoint or active work.
  action release = all {
    state.phase == "published", not(state.faults.checkpointRelease) or quiet(state.live),
    state' = state.with("phase", "live").with("batch", List()).with("candidate", emptyFrame).with("base", emptyFrame)
      .with("baseCheckpoint", emptyCheckpoint).with("save", false)
      .with("live", if (state.faults.lostWork) state.live.with("activeRef", -1) else state.live)
      .with("archive", if (state.faults.retainedHistory) state.archive.concat(state.batch) else List()),
  }
  // failBeforeCommit discards preparation and preserves both committed state and storage.
  action failBeforeCommit = all {
    state.phase == "prepared",
    state' = state.with("phase", "failed").with("candidate", emptyFrame).with("batch", List()).with("save", false).with("aborted", true)
      .with("live", if (state.faults.failedRollback) state.candidate else state.base),
  }
  // loseAcknowledgement preserves durable storage while the caller retains the previous committed frame until recovery.
  action loseAcknowledgement = all {
    state.phase == "committed",
    state' = state.with("phase", "failed").with("candidate", emptyFrame).with("batch", List()).with("save", false),
  }
  action crash = all {
    state.phase != "down",
    state' = initial(state.faults).with("journal", state.journal).with("checkpoint", state.checkpoint).with("phase", "down"),
  }
  // restore seeds actor state from the quiescent checkpoint; active work is reconstructed from journal records.
  action restore = all {
    state.phase.in(Set("failed", "down")),
    state' = initial(state.faults).with("journal", state.journal).with("checkpoint", state.checkpoint).with("phase", "recovering")
      .with("live", { position: state.checkpoint.position, actor: state.checkpoint.actor, activeRef: -1 }),
  }
  action replayNext = all {
    state.phase == "recovering", state.live.position < state.journal.length(),
    state' = state.with("live", reduce(state.live, state.journal.nth(state.live.position))),
  }
  action expose = all {
    state.phase == "recovering", state.live.position == state.journal.length(),
    state' = state.with("phase", "live"),
  }
  action hold = state' = state
  action stableStep = any { prepare, prepareCheckpoint, commit, publish, release, failBeforeCommit, loseAcknowledgement, restore, replayNext, expose, hold }
  action step = any { stableStep, crash }

  val checkpointSound = if (state.checkpoint.position.in(0.to(state.journal.length()))) all {
    state.checkpoint.actor == replay(state.journal.slice(0, state.checkpoint.position)).actor,
    quiet(replay(state.journal.slice(0, state.checkpoint.position))),
  } else false
  val visibleEquivalent = state.phase.in(Set("live", "prepared", "committed", "published", "failed")) implies
    (if (state.live.position <= state.journal.length()) state.live == replay(state.journal.slice(0, state.live.position)) else false)
  val visibleAtHead = state.phase.in(Set("live", "prepared", "published")) implies state.live.position == state.journal.length()
  val rollbackStable = state.aborted implies all {
    state.phase == "failed", state.live == state.base,
    state.journal.length() == state.base.position, state.checkpoint == state.baseCheckpoint,
  }
  val committedCandidate = state.phase.in(Set("committed", "published")) implies state.candidate == replay(state.journal)
  val retentionBound = state.archive == List() and state.batch.length() <= maxBatch
    and (state.phase.in(Set("live", "failed", "down", "recovering")) implies state.batch == List())
  val recoveryEquivalent = state.phase == "recovering" implies all {
    state.checkpoint.position <= state.live.position, state.live.position <= state.journal.length(),
    state.live == replay(state.journal.slice(0, state.live.position)),
  }
  pure def validFrame(frame: RuntimeFrame): bool = frame.position.in(0.to(capacity)) and frame.activeRef.in((-1).to(capacity - 1))
    and frame.actor.in(tuples(Set(false, true), Set(false, true)))
  val invariant = all {
    state.journal.in(histories), state.phase.in(phases),
    validFrame(state.live), validFrame(state.base), validFrame(state.candidate),
    checkpointSound, visibleEquivalent, visibleAtHead, rollbackStable, committedCandidate, retentionBound, recoveryEquivalent,
    state.phase == "prepared" implies all {
      state.candidate == foldFrame(state.base, state.batch),
      state.candidate == replay(state.journal.concat(state.batch)),
      state.candidate.position <= capacity, not(state.save) or quiet(state.candidate),
    },
    state.phase.in(Set("live", "down", "recovering")) implies state.base == emptyFrame and state.candidate == emptyFrame,
  }
  temporal publicationReleased = release.weakFair(state) implies
    (state.phase == "published").leadsTo(state.phase == "live")
  temporal recoveryProgress = (restore.weakFair(state) and replayNext.weakFair(state) and expose.weakFair(state)) implies
    state.phase.in(Set("down", "failed", "recovering")).leadsTo(state.phase == "live")

  run failedCommitTest = init.then(prepareBatch(List(domain(true)), true)).expect(invariant and state.live == emptyFrame)
    .then(failBeforeCommit).expect(invariant and rollbackStable and state.journal == List())
    .then(restore).then(expose).expect(invariant and state.live == emptyFrame)
  run pendingReleaseTest = init.then(prepareBatch(List(accept), false)).then(commit).then(publish).then(release)
    .expect(invariant and state.live.activeRef == 0 and state.batch == List() and state.checkpoint == emptyCheckpoint)
    .then(prepareBatch(List(domain(true)), false)).then(commit).then(publish).then(release)
    .then(prepareBatch(List(domain(false)), false)).then(commit).then(publish).then(release)
    .expect(invariant and state.live.position == 3 and state.live.activeRef == 0 and state.checkpoint == emptyCheckpoint and state.archive == List())
  run callbackCommitTest = init.then(prepareBatch(List(accept), false)).then(commit).then(publish).then(release)
    .then(prepareBatch(List(settle, domain(true)), true)).then(commit)
    .expect(invariant and state.live.position == 1 and state.journal.length() == 3 and state.checkpoint.position == 3)
    .then(publish).then(release).expect(invariant and quiet(state.live) and state.live.actor == (true, false))
  run acknowledgementLossTest = init.then(prepareBatch(List(accept), false)).then(commit).then(loseAcknowledgement)
    .expect(invariant and state.live == emptyFrame and state.journal == List(accept))
    .then(restore).then(replayNext).then(expose).expect(invariant and state.live.activeRef == 0 and state.batch == List())
  run crashBeforeReleaseTest = init.then(prepareBatch(List(accept), false)).then(commit).then(publish).then(crash)
    .then(restore).then(replayNext).then(expose).expect(invariant and state.live.activeRef == 0 and state.batch == List())
  run checkpointSuffixTest = init.then(prepareBatch(List(accept), false)).then(commit).then(publish).then(release)
    .then(prepareBatch(List(settle, domain(true)), true)).then(commit).then(publish).then(release)
    .then(prepareBatch(List(domain(true)), false)).then(commit).then(publish).then(release).then(crash)
    .then(restore).then(replayNext).then(expose).expect(invariant and state.live.position == 4 and graph(state.live.actor) == graph(replay(state.journal).actor))
  run crashDuringPreparationTest = init.then(prepareBatch(List(domain(true)), false)).then(crash)
    .then(restore).then(expose).expect(invariant and state.live == emptyFrame and state.journal == List())
}
