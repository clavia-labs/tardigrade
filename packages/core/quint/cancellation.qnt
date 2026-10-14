// cancellation models local durable cancellation and executor-owned forwarding (terminalExclusive, deliverySound, forwardingProgress).
// References 0, 1, and 2 form a possible ownership chain; reference 3 is unrelated work.
// requested, submitted, completed, cancelled, cancellationSettled, payloads, and links abstract durable records.
// running, online, cleanupRunning, cleanupReady, cleanupHandles, submissionHung, cleanupHung, and cleanupDied are volatile; acknowledgedSuccess and acknowledgedHandles are ghost history.
// submit represents EffectSettled with a deferred handle; finish represents immediate completion or PromiseSettled.
// Each action commits locally; forwarding is a separate child's cancellation commit and may race with its completion.
// Ownership acceptance is atomic here; implementations with separate logs must durably reconcile child submission before acknowledging cancellation cleanup.
// CancellationSettled acknowledges successful executor cleanup and releases its payload in the same local commit.
// Producer quiescence means the producer has joined or durably submitted its handle; it cannot submit after abort completes.
// Backend abort acknowledgement, remote side effects, checkpoint codecs, thread death, arbitrary graphs, and TypeScript refinement are outside this model.
// Fair forwarding with eventually available runtimes implies descendants become terminal; completion can win before cancellation arrives.
// Run verification from a temporary directory to keep backend artifacts outside the repository.
// quint verify /absolute/path/to/cancellation.qnt --inductive-invariant invariant --invariants terminalExclusive deliverySound ownershipSound cancellationIsolation submissionPreserved
// quint verify /absolute/path/to/cancellation.qnt --backend tlc --invariant invariant --temporal forwardingProgress
// initUnsafe removes the completion guard; terminalExclusive exposes a late-result counterexample.
// stepEarlyRelease, stepEarlyAcknowledgement, and stepEarlyCleanup violate cleanupInputsRetained, cleanupSettlementSound, and cleanupQuiescent respectively.
// initStalls restricts verification to four reachable cancellation failure scenarios; stepStalls keeps the runtime online without crash recovery.
// submissionProgress, cleanupProgress, deathProgress, and fairFailureProgress each intentionally fail under fair scheduling while invariant holds.
// quint verify /absolute/path/to/cancellation.qnt --backend tlc --init initStalls --step stepStalls --invariant invariant
// quint verify /absolute/path/to/cancellation.qnt --backend tlc --init initStalls --step stepStalls --temporal fairFailureProgress
// unconditionalCascade intentionally fails when an intermediate child completes before cancellation arrives.
// quint verify /absolute/path/to/cancellation.qnt --backend tlc --temporal unconditionalCascade
module cancellation {
  type Link = (int, int)
  type State = {
    requested: Set[int], submitted: Set[int], completed: Set[int], cancelled: Set[int],
    delivered: Set[int], links: Set[Link], direct: Set[int],
    running: Set[int], online: Set[int], guarded: bool,
    payloads: Set[int], cancellationSettled: Set[int], cleanupRunning: Set[int], cleanupReady: Set[int], cleanupHandles: Set[int],
    acknowledgedSuccess: Set[int], acknowledgedHandles: Set[int],
    submissionHung: Set[int], cleanupHung: Set[int], cleanupDied: Set[int],
  }
  pure val refs = Set(0, 1, 2, 3)
  pure val possibleLinks = Set((0, 1), (1, 2))
  var requested: Set[int]
  var submitted: Set[int]
  var completed: Set[int]
  var cancelled: Set[int]
  var delivered: Set[int]
  var links: Set[Link]
  var direct: Set[int]
  var running: Set[int]
  var online: Set[int]
  var guarded: bool
  var payloads: Set[int]
  var cancellationSettled: Set[int]
  var cleanupRunning: Set[int]
  var cleanupReady: Set[int]
  var cleanupHandles: Set[int]
  var acknowledgedSuccess: Set[int]
  var acknowledgedHandles: Set[int]
  var submissionHung: Set[int]
  var cleanupHung: Set[int]
  var cleanupDied: Set[int]
  val state: State = { requested: requested, submitted: submitted, completed: completed, cancelled: cancelled, delivered: delivered, links: links, direct: direct, running: running, online: online, guarded: guarded, payloads: payloads, cancellationSettled: cancellationSettled, cleanupRunning: cleanupRunning, cleanupReady: cleanupReady, cleanupHandles: cleanupHandles, acknowledgedSuccess: acknowledgedSuccess, acknowledgedHandles: acknowledgedHandles, submissionHung: submissionHung, cleanupHung: cleanupHung, cleanupDied: cleanupDied }
  action update(after: State): bool = all {
    requested' = after.requested, submitted' = after.submitted, completed' = after.completed, cancelled' = after.cancelled, delivered' = after.delivered, links' = after.links, direct' = after.direct, running' = after.running, online' = after.online, guarded' = after.guarded,
    payloads' = after.payloads, cancellationSettled' = after.cancellationSettled, cleanupRunning' = after.cleanupRunning, cleanupReady' = after.cleanupReady, cleanupHandles' = after.cleanupHandles, acknowledgedSuccess' = after.acknowledgedSuccess, acknowledgedHandles' = after.acknowledgedHandles, submissionHung' = after.submissionHung, cleanupHung' = after.cleanupHung, cleanupDied' = after.cleanupDied
  }
  action init = all {
    payloads' = Set(), cancellationSettled' = Set(), cleanupRunning' = Set(), cleanupReady' = Set(), cleanupHandles' = Set(),
    acknowledgedSuccess' = Set(), acknowledgedHandles' = Set(), submissionHung' = Set(), cleanupHung' = Set(), cleanupDied' = Set(),
    requested' = Set(), submitted' = Set(), completed' = Set(), cancelled' = Set(),
    delivered' = Set(), links' = Set(), direct' = Set(), running' = Set(), online' = refs, guarded' = true,
  }
  action initUnsafe = all {
    payloads' = Set(), cancellationSettled' = Set(), cleanupRunning' = Set(), cleanupReady' = Set(), cleanupHandles' = Set(),
    acknowledgedSuccess' = Set(), acknowledgedHandles' = Set(), submissionHung' = Set(), cleanupHung' = Set(), cleanupDied' = Set(),
    requested' = Set(), submitted' = Set(), completed' = Set(), cancelled' = Set(),
    delivered' = Set(), links' = Set(), direct' = Set(), running' = Set(), online' = refs, guarded' = false,
  }
  def terminal(ref: int): bool = state.completed.contains(ref) or state.cancelled.contains(ref)
  def pending(ref: int): bool = state.requested.contains(ref) and not(terminal(ref))

  action request(ref: int): bool = all {
    ref.in(Set(0, 3)), state.online.contains(ref), not(state.requested.contains(ref)),
    update(state.with("requested", state.requested.union(Set(ref))).with("payloads", state.payloads.union(Set(ref)))),
  }

  // own records acceptance and the executor's durable forwarding address before work can start.
  action own(link: Link): bool = all {
    link.in(possibleLinks), state.online.contains(link._1), pending(link._1),
    not(state.requested.contains(link._2)),
    update(state.with("links", state.links.union(Set(link)))
      .with("requested", state.requested.union(Set(link._2))).with("payloads", state.payloads.union(Set(link._2)))),
  }

  action start(ref: int): bool = all {
    state.online.contains(ref), pending(ref), not(state.running.contains(ref)),
    update(state.with("running", state.running.union(Set(ref)))),
  }

  // submit preserves an accepted deferred handle even if cancellation won while submission was running.
  action submit(ref: int): bool = all {
    state.online.contains(ref), state.running.contains(ref), not(state.completed.contains(ref)), not(state.submissionHung.contains(ref)),
    update(state.with("submitted", state.submitted.union(Set(ref)))
      .with("running", state.running.exclude(Set(ref)))),
  }

  // finish accepts a result only while its immediate reference remains pending.
  action finish(ref: int): bool = all {
    state.online.contains(ref), state.requested.contains(ref),
    state.running.contains(ref) or state.submitted.contains(ref), not(state.submissionHung.contains(ref)),
    not(state.guarded) or not(state.cancelled.contains(ref)),
    update(state.with("completed", state.completed.union(Set(ref)))
      .with("running", state.running.exclude(Set(ref))).with("payloads", state.payloads.exclude(Set(ref)))),
  }

  action deliver(ref: int): bool = all {
    state.online.contains(ref), terminal(ref),
    update(state.with("delivered", state.delivered.union(Set(ref)))),
  }

  // cancel commits EffectCancelled locally; duplicates and completion-first requests leave the outcome unchanged.
  action cancel(ref: int): bool = all {
    state.online.contains(ref), state.requested.contains(ref),
    update(if (terminal(ref)) state else
      state.with("cancelled", state.cancelled.union(Set(ref))).with("direct", state.direct.union(Set(ref)))),
  }

  // forward acknowledges child cancellation only after the child's durable terminal decision.
  action forward(link: Link): bool = all {
    state.links.contains(link), state.cancelled.contains(link._1), pending(link._2),
    state.online.contains(link._1), state.online.contains(link._2),
    update(state.with("cancelled", state.cancelled.union(Set(link._2)))),
  }

  // abort joins the cancelled producer before cleanup can acknowledge the final known submission.
  action abort(ref: int): bool = all {
    state.online.contains(ref), state.cancelled.contains(ref), state.running.contains(ref), not(state.submissionHung.contains(ref)),
    update(state.with("running", state.running.exclude(Set(ref)))),
  }

  def forwardingComplete(ref: int): bool = state.links.forall(link => link._1 != ref or terminal(link._2))
  def cleanupPending(ref: int): bool = state.cancelled.contains(ref) and not(state.cancellationSettled.contains(ref))

  // beginCleanup waits for producer quiescence and records the handle visible to this attempt.
  action beginCleanupWithQuiescence(ref: int, check: bool): bool = all {
    state.online.contains(ref), cleanupPending(ref), state.payloads.contains(ref),
    not(state.cleanupRunning.contains(ref)), not(state.cleanupReady.contains(ref)), not(state.cleanupDied.contains(ref)),
    not(check) or not(state.running.contains(ref)),
    update(state.with("cleanupRunning", state.cleanupRunning.union(Set(ref)))
      .with("cleanupHandles", if (state.submitted.contains(ref)) state.cleanupHandles.union(Set(ref)) else state.cleanupHandles.exclude(Set(ref)))),
  }
  action beginCleanup(ref: int): bool = beginCleanupWithQuiescence(ref, true)
  // failCleanup leaves cancellation and input durable so a subsequent attempt can retry.
  action failCleanup(ref: int): bool = all {
    state.cleanupRunning.contains(ref), not(state.cleanupHung.contains(ref)),
    update(state.with("cleanupRunning", state.cleanupRunning.exclude(Set(ref))).with("cleanupHandles", state.cleanupHandles.exclude(Set(ref)))),
  }
  // finishCleanup records volatile success; a crash before CancellationSettled requires another attempt.
  action finishCleanup(ref: int): bool = all {
    state.cleanupRunning.contains(ref), not(state.cleanupHung.contains(ref)), forwardingComplete(ref),
    update(state.with("cleanupRunning", state.cleanupRunning.exclude(Set(ref))).with("cleanupReady", state.cleanupReady.union(Set(ref)))),
  }
  // settleCancellation commits CancellationSettled and payload deletion together after successful cleanup.
  action settleCancellationWithSuccess(ref: int, check: bool): bool = all {
    state.online.contains(ref), cleanupPending(ref),
    not(check) or (state.cleanupReady.contains(ref) and not(state.running.contains(ref)) and forwardingComplete(ref)
      and state.submitted.contains(ref) == state.cleanupHandles.contains(ref)),
    update(state.with("cancellationSettled", state.cancellationSettled.union(Set(ref))).with("payloads", state.payloads.exclude(Set(ref)))
      .with("cleanupReady", state.cleanupReady.exclude(Set(ref))).with("cleanupRunning", state.cleanupRunning.exclude(Set(ref)))
      .with("acknowledgedSuccess", if (state.cleanupReady.contains(ref)) state.acknowledgedSuccess.union(Set(ref)) else state.acknowledgedSuccess)
      .with("acknowledgedHandles", if (state.cleanupHandles.contains(ref)) state.acknowledgedHandles.union(Set(ref)) else state.acknowledgedHandles)
      .with("cleanupHandles", state.cleanupHandles.exclude(Set(ref)))),
  }
  action settleCancellation(ref: int): bool = settleCancellationWithSuccess(ref, true)

  action crash(ref: int): bool = all {
    state.online.contains(ref),
    update(state.with("online", state.online.exclude(Set(ref))).with("running", state.running.exclude(Set(ref)))
      .with("cleanupRunning", state.cleanupRunning.exclude(Set(ref))).with("cleanupReady", state.cleanupReady.exclude(Set(ref)))
      .with("cleanupHandles", state.cleanupHandles.exclude(Set(ref)))
      .with("submissionHung", state.submissionHung.exclude(Set(ref))).with("cleanupHung", state.cleanupHung.exclude(Set(ref)))
      .with("cleanupDied", state.cleanupDied.exclude(Set(ref)))),
  }

  // reopen retains durable cancellation and ownership; start cannot restart cancelled references.
  action reopen(ref: int): bool = all {
    not(state.online.contains(ref)), update(state.with("online", state.online.union(Set(ref)))),
  }

  // hangSubmission models an uninterruptible submission that supplies neither a handle nor a join acknowledgement.
  action hangSubmission(ref: int): bool = all {
    state.running.contains(ref),
    update(state.with("submissionHung", state.submissionHung.union(Set(ref)))),
  }
  // hangCleanup models a handler that supplies no success, typed failure, or defect.
  action hangCleanup(ref: int): bool = all {
    state.cleanupRunning.contains(ref),
    update(state.with("cleanupHung", state.cleanupHung.union(Set(ref)))),
  }
  // dieCleanup models volatile failure reporting and the runtime's claimed-cleanup guard; crash clears that guard.
  action dieCleanup(ref: int): bool = all {
    state.cleanupRunning.contains(ref), not(state.cleanupHung.contains(ref)),
    update(state.with("cleanupRunning", state.cleanupRunning.exclude(Set(ref)))
      .with("cleanupHandles", state.cleanupHandles.exclude(Set(ref))).with("cleanupDied", state.cleanupDied.union(Set(ref)))),
  }

  action step = {
    nondet ref = refs.oneOf()
    nondet link = possibleLinks.oneOf()
    any { request(ref), own(link), start(ref), submit(ref), finish(ref), deliver(ref),
      cancel(ref), forward(link), abort(ref), beginCleanup(ref), failCleanup(ref), finishCleanup(ref), settleCancellation(ref),
      hangSubmission(ref), hangCleanup(ref), dieCleanup(ref), crash(ref), reopen(ref), update(state) }
  }

  action stepEarlyRelease = {
    nondet ref = refs.oneOf()
    any { step, all { cleanupPending(ref), update(state.with("payloads", state.payloads.exclude(Set(ref)))) } }
  }
  action stepEarlyAcknowledgement = {
    nondet ref = refs.oneOf()
    any { step, settleCancellationWithSuccess(ref, false) }
  }

  action stepEarlyCleanup = {
    nondet ref = refs.oneOf()
    any { step, beginCleanupWithQuiescence(ref, false) }
  }

  val cleanupQuiescent = state.cleanupRunning.union(state.cleanupReady).intersect(state.running) == Set()
  val cleanupInputsRetained = state.requested.exclude(state.completed).exclude(state.cancellationSettled).subseteq(state.payloads)
  val cleanupSettlementSound = state.cancellationSettled.subseteq(state.cancelled.intersect(state.acknowledgedSuccess))
    and state.cancellationSettled.intersect(state.payloads) == Set()
    and state.cancellationSettled.intersect(state.cleanupRunning.union(state.cleanupReady)) == Set()
    and state.cancellationSettled.intersect(state.running) == Set()
    and state.cancellationSettled.intersect(state.submitted).subseteq(state.acknowledgedHandles)
    and state.cancellationSettled.forall(ref => forwardingComplete(ref))
  val cleanupRetryAvailable = state.cancelled.exists(ref => state.online.contains(ref)
    and not(state.cancellationSettled.contains(ref)) and not(state.cleanupRunning.contains(ref)) and not(state.cleanupReady.contains(ref))
    and not(state.cleanupDied.contains(ref)) and not(state.running.contains(ref)))
  val cleanupReleased = state.cancellationSettled != Set()
  val terminalExclusive = state.completed.intersect(state.cancelled) == Set()
  val deliverySound = state.delivered.subseteq(state.completed.union(state.cancelled))
  val ownershipSound = state.links.forall(link => state.requested.contains(link._1) and state.requested.contains(link._2))
  val cancellationIsolation = state.cancelled.forall(ref => state.direct.contains(ref) or
    state.links.exists(link => link._2 == ref and state.cancelled.contains(link._1)))
  val submissionPreserved = state.submitted.subseteq(state.requested)
  val invariant = all {
    requested.in(refs.powerset()), submitted.in(refs.powerset()), completed.in(refs.powerset()),
    cancelled.in(refs.powerset()), delivered.in(refs.powerset()), direct.in(refs.powerset()),
    running.in(refs.powerset()), online.in(refs.powerset()), links.in(possibleLinks.powerset()),
    guarded == true, state.submitted.subseteq(state.requested),
    state.completed.subseteq(state.requested), state.cancelled.subseteq(state.requested),
    state.delivered.subseteq(state.completed.union(state.cancelled)), state.direct.subseteq(state.cancelled),
    state.running.subseteq(state.requested), state.running.subseteq(state.online),
    state.running.intersect(state.completed) == Set(), state.online.subseteq(refs),
    state.links.subseteq(possibleLinks), state.guarded,
    payloads.subseteq(requested), cancellationSettled.subseteq(cancelled),
    submissionHung.subseteq(running), cleanupHung.subseteq(cleanupRunning), cleanupDied.subseteq(cancelled.intersect(online)),
    cleanupDied.intersect(cleanupRunning.union(cleanupReady).union(cancellationSettled)) == Set(),
    cleanupRunning.union(cleanupReady).subseteq(cancelled.intersect(online)), cleanupRunning.intersect(cleanupReady) == Set(),
    cleanupHandles.subseteq(cleanupRunning.union(cleanupReady)), acknowledgedSuccess.subseteq(cancelled), acknowledgedHandles.subseteq(cancellationSettled),
    cleanupInputsRetained, cleanupSettlementSound, cleanupQuiescent,
    terminalExclusive, deliverySound, ownershipSound, cancellationIsolation, submissionPreserved,
  }

  run cleanupCrashBeforeAcknowledgementTest = init.then(request(0)).then(start(0)).then(cancel(0)).then(abort(0))
    .then(beginCleanup(0)).then(finishCleanup(0)).then(crash(0)).then(reopen(0))
    .expect(cleanupRetryAvailable and state.payloads.contains(0))
    .then(beginCleanup(0)).then(finishCleanup(0)).then(settleCancellation(0)).then(crash(0)).then(reopen(0))
    .expect(invariant and state.cancellationSettled.contains(0) and not(state.payloads.contains(0)) and not(cleanupPending(0)))
  run cleanupFailureRetryTest = init.then(request(0)).then(cancel(0)).then(beginCleanup(0)).then(failCleanup(0))
    .expect(state.payloads.contains(0) and not(state.cancellationSettled.contains(0)))
    .then(beginCleanup(0)).then(finishCleanup(0)).then(settleCancellation(0)).expect(invariant)
  run lateSubmissionCleanupTest = init.then(request(0)).then(start(0)).then(cancel(0)).then(submit(0))
    .then(beginCleanup(0)).then(finishCleanup(0)).then(settleCancellation(0))
    .expect(invariant and state.acknowledgedHandles.contains(0))
  run forwardedCleanupTest = init.then(request(0)).then(own((0, 1))).then(cancel(0)).then(beginCleanup(0))
    .expect(not(forwardingComplete(0)))
    .then(forward((0, 1))).then(finishCleanup(0)).then(settleCancellation(0))
    .expect(invariant and cleanupPending(1) and state.payloads.contains(1) and not(state.payloads.contains(0)))
  run earlyCleanupTest = init.then(request(0)).then(start(0)).then(cancel(0)).then(beginCleanupWithQuiescence(0, false))
    .expect(not(cleanupQuiescent))
  run earlyAcknowledgementTest = init.then(request(0)).then(cancel(0)).then(settleCancellationWithSuccess(0, false))
    .expect(not(cleanupSettlementSound))
  run earlyReleaseTest = init.then(request(0)).then(cancel(0)).then(update(state.with("payloads", Set())))
    .expect(not(cleanupInputsRetained))

  run hungSubmissionTest = init.then(request(0)).then(start(0)).then(hangSubmission(0)).then(cancel(0))
    .expect(invariant and state.submissionHung.contains(0) and not(cleanupRetryAvailable))
  run hungCleanupTest = init.then(request(0)).then(cancel(0)).then(beginCleanup(0)).then(hangCleanup(0))
    .expect(invariant and state.cleanupHung.contains(0) and not(cleanupRetryAvailable))
  run cleanupDiedTest = init.then(request(0)).then(cancel(0)).then(beginCleanup(0)).then(dieCleanup(0)).then(cancel(0))
    .expect(invariant and state.payloads.contains(0) and state.cleanupDied.contains(0) and not(cleanupRetryAvailable) and not(state.cancellationSettled.contains(0)))
    .then(crash(0)).then(reopen(0)).then(beginCleanup(0)).then(finishCleanup(0)).then(settleCancellation(0)).expect(invariant)

  // initStalls contains states reachable through hungSubmissionTest, hungCleanupTest, cleanupDiedTest, and cleanupFailureRetryTest.
  action initStalls = {
    nondet mode = Set("submission", "cleanup", "death", "failure").oneOf()
    all {
      requested' = Set(0), cancelled' = Set(0), direct' = Set(0), payloads' = Set(0), online' = refs, guarded' = true,
      submitted' = Set(), completed' = Set(), delivered' = Set(), links' = Set(), cancellationSettled' = Set(),
      acknowledgedSuccess' = Set(), acknowledgedHandles' = Set(), cleanupReady' = Set(), cleanupHandles' = Set(),
      running' = if (mode == "submission") Set(0) else Set(),
      submissionHung' = if (mode == "submission") Set(0) else Set(),
      cleanupRunning' = if (mode == "cleanup") Set(0) else Set(),
      cleanupHung' = if (mode == "cleanup") Set(0) else Set(),
      cleanupDied' = if (mode == "death") Set(0) else Set(),
    }
  }
  action stepStalls = any { abort(0), submit(0), beginCleanup(0), failCleanup(0), finishCleanup(0), settleCancellation(0), cancel(0), update(state) }
  temporal cancellationProgress = state.cancelled.contains(0).leadsTo(state.cancellationSettled.contains(0))
  // responsiveRuntime excludes scheduler starvation while permitting an external operation to remain unresponsive.
  temporal responsiveRuntime = abort(0).weakFair(state) and submit(0).weakFair(state)
    and beginCleanup(0).weakFair(state) and finishCleanup(0).weakFair(state) and settleCancellation(0).weakFair(state)
  temporal submissionProgress = (state.submissionHung.contains(0) and responsiveRuntime) implies cancellationProgress
  temporal cleanupProgress = (state.cleanupHung.contains(0) and responsiveRuntime) implies cancellationProgress
  temporal deathProgress = (state.cleanupDied.contains(0) and responsiveRuntime) implies cancellationProgress
  // fairFailureProgress requires retry attempts and failures to occur; typed failures can defeat progress even with weakly fair success scheduling.
  temporal fairFailureProgress = (
    state.submissionHung == Set() and state.cleanupHung == Set() and state.cleanupDied == Set()
    and responsiveRuntime and failCleanup(0).weakFair(state)
  ) implies cancellationProgress

  temporal forwardingProgress = (
    eventually(always(state.online == refs)) and
    forward((0, 1)).weakFair(state) and forward((1, 2)).weakFair(state)
  ) implies (
    (state.cancelled.contains(0) and state.links.contains((0, 1))).leadsTo(terminal(1)) and
    (state.cancelled.contains(1) and state.links.contains((1, 2))).leadsTo(terminal(2))
  )

  temporal unconditionalCascade = (
    eventually(always(state.online == refs)) and
    forward((0, 1)).weakFair(state) and forward((1, 2)).weakFair(state)
  ) implies (
    (state.cancelled.contains(0) and state.links == possibleLinks).leadsTo(terminal(1) and terminal(2))
  )
}
