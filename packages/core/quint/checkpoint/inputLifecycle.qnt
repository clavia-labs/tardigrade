// inputLifecycle composes effectInput storage contracts with lifecycleCheckpoint admission and recovery.
// Every lifecycle transition projects to the imported model; hydration and release stutter on that state.
// Original proposals stand for deterministic reconstruction from retained domain state and configuration.
// The imported model supplies atomic commits, quiescent checkpoints, producer ownership, and callback batches.
// Cancellation cleanup, omitted durable atoms, cryptographic collisions, byte growth, and TypeScript refinement are outside this composition.
// quint verify packages/core/quint/checkpoint/inputLifecycle.qnt --backend tlc --invariant invariant
// stepWithoutVerification and stepEarlyRelease must violate verifiedExecution and inputRetained respectively.
module inputLifecycle {
  import lifecycleCheckpoint as lifecycle from "./lifecycleCheckpoint"
  import effectInput as input from "../effectInput"

  var requests: int -> input::Stored
  var loaded: int -> input::Proposal
  var lost: Set[int]
  var staged: List[input::Stored]

  action init = all {
    lifecycle::init,
    requests' = Map(), loaded' = Map(), lost' = Set(), staged' = List(),
  }
  action hold = all {
    requests' = requests, loaded' = loaded, lost' = lost, staged' = staged,
  }
  pure def active(status: int): bool = status.in(Set(1, 2, 3))
  val committed = lifecycle::replay(lifecycle::journal)
  def needed(ref: int): bool = lifecycle::runningRef == ref
    or (committed.ref == ref and active(committed.status))
    or (lifecycle::live.ref == ref and active(lifecycle::live.status))
  def available(ref: int): bool = loaded.keys().contains(ref)

  // prepare retains the original proposal until acceptance commits; callbacks require reconstructed input.
  action prepare = {
    nondet inline = Set(false, true).oneOf()
    nondet key = input::operationKeys.oneOf()
    all {
      lifecycle::prepare,
      key._2 == input::original(lifecycle::live.position).act,
      active(lifecycle::live.status) implies available(lifecycle::live.ref),
      staged' = List(input::encode(input::reference(lifecycle::live.position, key), input::original(lifecycle::live.position), inline)),
      requests' = requests, loaded' = loaded, lost' = lost,
    }
  }
  // commit stores the request before either its reference or execution becomes visible.
  val accepting = lifecycle::batch.length() == 1 and lifecycle::batch.nth(0).kind == 1
  action commit = all {
    lifecycle::commit,
    requests' = if (accepting) requests.put(staged.nth(0).ref.seq, staged.nth(0)) else requests,
    loaded' = if (accepting) loaded.put(staged.nth(0).ref.seq, input::original(staged.nth(0).ref.seq)) else loaded,
    lost' = lost, staged' = List(),
  }
  action publish = all { lifecycle::publish, hold }
  action prepareCheckpoint = all { lifecycle::prepareCheckpoint, hold }

  // hydrateWithVerification checks reconstructed input against the committed request when verification is enabled.
  action hydrateWithVerification(check: bool): bool = {
    nondet proposal = input::proposals.oneOf()
    val ref = lifecycle::live.ref
    all {
      lifecycle::phase == "live", requests.keys().contains(ref), needed(ref), not(available(ref)),
      not(check) or input::matches(requests.get(ref), proposal),
      lifecycle::update(lifecycle::state),
      loaded' = loaded.put(ref, proposal), lost' = lost.exclude(Set(ref)),
      requests' = requests, staged' = staged,
    }
  }
  action hydrate = hydrateWithVerification(true)
  action dispatch = all { available(lifecycle::live.ref), lifecycle::dispatch, hold }
  action restart = all { available(lifecycle::live.ref), lifecycle::restart, hold }
  action observe = all { lifecycle::observe, hold }
  action arrive = all { lifecycle::arrive, hold }
  action retry = all { lifecycle::retry, hold }

  // releaseWithRetention protects active input obligations when retention is enabled.
  action releaseWithRetention(check: bool): bool = {
    nondet ref = loaded.keys().oneOf()
    all {
      not(check) or not(needed(ref)), lifecycle::update(lifecycle::state),
      loaded' = loaded.keys().exclude(Set(ref)).mapBy(key => loaded.get(key)), requests' = requests, lost' = lost, staged' = staged,
    }
  }
  action release = releaseWithRetention(true)
  // crash discards volatile input; request identity and storage representation remain committed.
  action crash = all {
    lifecycle::crash, requests' = requests, loaded' = Map(), lost' = requests.keys(), staged' = List(),
  }
  action restore = all { lifecycle::restore, hold }
  action replayNext = all { lifecycle::replayNext, hold }
  action expose = all { lifecycle::expose, hold }
  action advance = any { prepare, prepareCheckpoint, commit, publish, dispatch, restart, observe,
    arrive, retry, crash, restore, replayNext, expose }
  action step = any { advance, hydrate, release }
  action stepWithoutVerification = any { advance, hydrateWithVerification(false), release }
  action stepEarlyRelease = any { advance, hydrate, releaseWithRetention(false) }

  val requestPositions = lifecycle::journal.indices().filter(i => lifecycle::journal.nth(i).kind == 1)
  val identityPreserved = requests.keys() == requestPositions and requests.keys().forall(ref =>
    requests.get(ref).ref.seq == ref and requests.get(ref).ref.act == requests.get(ref).act and input::operationKeys.contains((requests.get(ref).ref.atom, requests.get(ref).ref.act)))
  val observerEquivalent = requests.keys().forall(ref =>
    input::observe(requests.get(ref)) == input::observe(input::encode(requests.get(ref).ref, input::original(ref), true)))
  val observationIndependent = 0.to(lifecycle::capacity).forall(position => input::operationKeys.forall(key =>
    input::proposals.forall(left => input::proposals.forall(right => left.act == right.act implies
      input::observe(input::encode(input::reference(position, key), left, true))
        == input::observe(input::encode(input::reference(position, key), right, false))))))
  val verifiedExecution = lifecycle::runningRef == -1 or
    (available(lifecycle::runningRef) and input::matches(requests.get(lifecycle::runningRef), loaded.get(lifecycle::runningRef)))
  val inputRetained = requests.keys().forall(ref => needed(ref) and not(lost.contains(ref)) implies available(ref))
  val invariant = all {
    lifecycle::invariant, identityPreserved, observerEquivalent, observationIndependent, verifiedExecution, inputRetained,
    loaded.keys().subseteq(requests.keys()), lost.subseteq(requests.keys()),
    requests.keys().forall(ref => input::matches(requests.get(ref), input::original(ref))),
    staged.length().in(Set(0, 1)),
    staged.length() == 1 implies lifecycle::phase == "prepared" and lifecycle::batch.length() == 1,
  }
}
