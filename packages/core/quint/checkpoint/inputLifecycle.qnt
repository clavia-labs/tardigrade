// inputLifecycle models durable accepted input with lifecycleCheckpoint admission and recovery.
// Inputs are finite symbols; digest equality identifies equal canonical input as in effectInput.qnt.
// accepted is ghost state recording the input at acceptance; recovery cannot read it.
// payloads models durable input storage written before digest-only acceptance; loaded is volatile.
// image identifies the current runtime and changes reconstructed proposals after deployment.
// The TypeScript runtime hydrates persisted input and verifies reconstruction for legacy digest-only requests.
// cancellation.qnt models cleanup acknowledgement and payload retention; cancellation checkpoint composition is outside this model.
// Cryptographic collisions, storage failures, producer compatibility, and TypeScript refinement are outside this composition.
// quint verify packages/core/quint/checkpoint/inputLifecycle.qnt --backend tlc --invariant invariant
// stepWithoutVerification and stepEarlyRelease must violate verifiedExecution and inputRetained respectively.
module inputLifecycle {
  import lifecycleCheckpoint as lifecycle from "./lifecycleCheckpoint"
  import effectInput as input from "../effectInput"

  type Execution = { acceptance: input::Acceptance, proposal: input::Proposal, image: int }
  var requests: int -> input::Stored
  var accepted: int -> input::Proposal
  var payloads: int -> input::Proposal
  var loaded: int -> input::Proposal
  var staged: List[input::Stored]
  var image: int
  var executed: Set[Execution]

  action init = all {
    lifecycle::init,
    requests' = Map(), accepted' = Map(), payloads' = Map(), loaded' = Map(), staged' = List(),
    image' = 0, executed' = Set(),
  }
  action hold = all {
    requests' = requests, accepted' = accepted, payloads' = payloads, loaded' = loaded, staged' = staged,
    image' = image, executed' = executed,
  }
  pure def active(status: int): bool = status.in(Set(1, 2, 3))
  val committed = lifecycle::replay(lifecycle::journal)
  def needed(ref: int): bool = lifecycle::runningRef == ref
    or (committed.ref == ref and active(committed.status))
    or (lifecycle::live.ref == ref and active(lifecycle::live.status))
  def available(ref: int): bool = loaded.keys().contains(ref)
  def currentProposal(ref: int): input::Proposal = {
    act: input::original(ref).act, input: (input::original(ref).input + image) % 2,
  }
  pure def hasPayload(request: input::Stored, values: int -> input::Proposal): bool =
    request.inline != Set() or (values.keys().contains(request.ref.seq) and input::matches(request, values.get(request.ref.seq)))
  pure def payloadMatches(request: input::Stored, proposal: input::Proposal, values: int -> input::Proposal): bool =
    if (request.inline != Set()) proposal.act == request.act and request.inline == Set(proposal.input)
    else values.keys().contains(request.ref.seq) and proposal == values.get(request.ref.seq)

  // prepare captures the current proposal; deployment cannot change an in-progress acceptance.
  action prepare = {
    nondet inline = Set(false, true).oneOf()
    nondet key = input::operationKeys.oneOf()
    all {
      lifecycle::prepare,
      key._2 == currentProposal(lifecycle::live.position).act,
      active(lifecycle::live.status) implies available(lifecycle::live.ref),
      staged' = List(input::encode(input::reference(lifecycle::live.position, key), currentProposal(lifecycle::live.position), inline)),
      requests' = requests, accepted' = accepted, payloads' = payloads, loaded' = loaded,
      image' = image, executed' = executed,
    }
  }
  val accepting = lifecycle::batch.length() == 1 and lifecycle::batch.nth(0).kind == 1
  // persist writes a recoverable payload before committing a digest-only request; a crash may leave an orphan.
  action persist = all {
    lifecycle::phase == "prepared", accepting,
    staged.nth(0).inline == Set(),
    lifecycle::update(lifecycle::state),
    payloads' = payloads.put(staged.nth(0).ref.seq, currentProposal(staged.nth(0).ref.seq)),
    requests' = requests, accepted' = accepted, loaded' = loaded, staged' = staged,
    image' = image, executed' = executed,
  }
  // commit requires recoverable input before acceptance becomes durable or executable.
  action commit = all {
    lifecycle::phase == "prepared",
    accepting implies hasPayload(staged.nth(0), payloads),
    lifecycle::commit,
    requests' = if (accepting) requests.put(staged.nth(0).ref.seq, staged.nth(0)) else requests,
    accepted' = if (accepting) accepted.put(staged.nth(0).ref.seq, currentProposal(staged.nth(0).ref.seq)) else accepted,
    loaded' = if (accepting) loaded.put(staged.nth(0).ref.seq, currentProposal(staged.nth(0).ref.seq)) else loaded,
    payloads' = payloads, staged' = List(), image' = image, executed' = executed,
  }
  action publish = all { lifecycle::publish, hold }
  action prepareCheckpoint = all { lifecycle::prepareCheckpoint, hold }

  // deploy changes the runtime and its proposals while preserving accepted requests and durable payloads.
  action deploy = all {
    lifecycle::phase == "down", lifecycle::update(lifecycle::state),
    image' = 1 - image,
    requests' = requests, accepted' = accepted, payloads' = payloads, loaded' = loaded, staged' = staged, executed' = executed,
  }
  // hydrate reads accepted input from inline storage or the durable payload, independently of the current proposal.
  action hydrate = {
    nondet proposal = input::proposals.oneOf()
    val ref = lifecycle::live.ref
    all {
      lifecycle::phase == "live", requests.keys().contains(ref), needed(ref), not(available(ref)),
      payloadMatches(requests.get(ref), proposal, payloads), input::matches(requests.get(ref), proposal),
      lifecycle::update(lifecycle::state),
      loaded' = loaded.put(ref, proposal),
      requests' = requests, accepted' = accepted, payloads' = payloads, staged' = staged, image' = image, executed' = executed,
    }
  }
  // hydrateFromProposal models substituting replacement code's input for accepted input.
  action hydrateFromProposal = {
    val ref = lifecycle::live.ref
    all {
      lifecycle::phase == "live", requests.keys().contains(ref), needed(ref), not(available(ref)),
      lifecycle::update(lifecycle::state),
      loaded' = loaded.put(ref, currentProposal(ref)),
      requests' = requests, accepted' = accepted, payloads' = payloads, staged' = staged, image' = image, executed' = executed,
    }
  }
  action execute(restart: bool): bool = {
    val ref = lifecycle::live.ref
    all {
      available(ref), if (restart) lifecycle::restart else lifecycle::dispatch,
      executed' = Set({ acceptance: input::observe(requests.get(ref)), proposal: loaded.get(ref), image: image }),
      requests' = requests, accepted' = accepted, payloads' = payloads, loaded' = loaded, staged' = staged, image' = image,
    }
  }
  action dispatch = execute(false)
  action restart = execute(true)
  action observe = all { lifecycle::observe, hold }
  action arrive = all { lifecycle::arrive, hold }
  action retry = all { lifecycle::retry, hold }

  // releaseWithRetention retains durable payloads and loaded input until execution and deferred recovery are terminal.
  action releaseWithRetention(check: bool): bool = {
    nondet ref = loaded.keys().union(payloads.keys()).oneOf()
    all {
      not(check) or (not(needed(ref)) and not(lifecycle::phase == "prepared" and accepting and staged.nth(0).ref.seq == ref)),
      lifecycle::update(lifecycle::state),
      loaded' = loaded.keys().exclude(Set(ref)).mapBy(key => loaded.get(key)),
      payloads' = payloads.keys().exclude(Set(ref)).mapBy(key => payloads.get(key)),
      requests' = requests, accepted' = accepted, staged' = staged, image' = image, executed' = executed,
    }
  }
  action release = releaseWithRetention(true)
  // crash loses volatile input and staging while durable requests and payloads survive.
  action crash = all {
    lifecycle::crash, requests' = requests, accepted' = accepted, payloads' = payloads, loaded' = Map(), staged' = List(),
    image' = image, executed' = executed,
  }
  action restore = all { lifecycle::restore, hold }
  action replayNext = all { lifecycle::replayNext, hold }
  action expose = all { lifecycle::expose, hold }
  action advance = any { prepare, persist, prepareCheckpoint, commit, publish, dispatch, restart, observe,
    arrive, retry, crash, deploy, restore, replayNext, expose }
  action step = any { advance, hydrate, release }
  action stepWithoutVerification = any { advance, hydrateFromProposal, release }
  action stepEarlyRelease = any { advance, hydrate, releaseWithRetention(false) }

  val requestPositions = lifecycle::journal.indices().filter(i => lifecycle::journal.nth(i).kind == 1)
  val identityPreserved = requests.keys() == requestPositions and requests.keys() == accepted.keys() and requests.keys().forall(ref =>
    requests.get(ref).ref.seq == ref and requests.get(ref).ref.act == requests.get(ref).act and input::operationKeys.contains((requests.get(ref).ref.atom, requests.get(ref).ref.act)))
  val observerEquivalent = requests.keys().forall(ref =>
    input::observe(requests.get(ref)) == input::observe(input::encode(requests.get(ref).ref, accepted.get(ref), true)))
  val observationIndependent = 0.to(lifecycle::capacity).forall(position => input::operationKeys.forall(key =>
    input::proposals.forall(left => input::proposals.forall(right => left.act == right.act implies
      input::observe(input::encode(input::reference(position, key), left, true))
        == input::observe(input::encode(input::reference(position, key), right, false))))))
  val verifiedExecution = executed.forall(work =>
    requests.keys().contains(work.acceptance.ref.seq)
    and work.acceptance == input::observe(requests.get(work.acceptance.ref.seq))
    and work.proposal == accepted.get(work.acceptance.ref.seq)
    and work.image.in(Set(0, 1)))
  val inputRetained = requests.keys().forall(ref => needed(ref) implies hasPayload(requests.get(ref), payloads))
  val recoveredAfterDeploy = executed.exists(work => work.proposal != currentProposal(work.acceptance.ref.seq) and work.image == image)
  val recoveredDigestAfterDeploy = recoveredAfterDeploy and executed.exists(work =>
    requests.get(work.acceptance.ref.seq).inline == Set())
  val releasedAfterSettlement = requests.keys().exists(ref =>
    not(needed(ref)) and requests.get(ref).inline == Set()
      and not(payloads.keys().contains(ref)) and not(loaded.keys().contains(ref)))
  val invariant = all {
    lifecycle::invariant, identityPreserved, observerEquivalent, observationIndependent, verifiedExecution, inputRetained,
    loaded.keys().subseteq(requests.keys()), image.in(Set(0, 1)), executed.size() <= 1,
    requests.keys().forall(ref => input::matches(requests.get(ref), accepted.get(ref))),
    loaded.keys().forall(ref => loaded.get(ref).in(input::proposals)),
    payloads.keys().forall(ref => ref.in(0.to(lifecycle::capacity - 1)) and payloads.get(ref).in(input::proposals)),
    staged.length().in(Set(0, 1)),
    staged.length() == 1 implies lifecycle::phase == "prepared" and lifecycle::batch.length() == 1,
  }
}
