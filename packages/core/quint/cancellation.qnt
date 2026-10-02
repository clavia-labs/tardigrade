// cancellation models local durable cancellation and executor-owned forwarding (terminalExclusive, deliverySound, forwardingProgress).
// References 0, 1, and 2 form a possible ownership chain; reference 3 is unrelated work.
// requested, submitted, completed, cancelled, and links abstract durable records; running and online are volatile.
// submit represents EffectSettled with a deferred handle; finish represents immediate completion or PromiseSettled.
// Each action commits locally; forwarding is a separate child's cancellation commit and may race with its completion.
// Ownership acceptance is atomic here; implementations with separate logs must durably reconcile child submission before acknowledging cancellation cleanup.
// Backend abort acknowledgement, remote side effects, checkpoint codecs, arbitrary graphs, and TypeScript refinement are outside this model.
// Fair forwarding with eventually available runtimes implies descendants become terminal; completion can win before cancellation arrives.
// Run verification from a temporary directory to keep backend artifacts outside the repository.
// quint verify /absolute/path/to/cancellation.qnt --inductive-invariant invariant --invariants terminalExclusive deliverySound ownershipSound cancellationIsolation submissionPreserved
// quint verify /absolute/path/to/cancellation.qnt --backend tlc --invariant invariant --temporal forwardingProgress
// initUnsafe removes the completion guard; terminalExclusive exposes a late-result counterexample.
// unconditionalCascade intentionally fails when an intermediate child completes before cancellation arrives.
// quint verify /absolute/path/to/cancellation.qnt --backend tlc --temporal unconditionalCascade
module cancellation {
  type Link = (int, int)
  type State = {
    requested: Set[int], submitted: Set[int], completed: Set[int], cancelled: Set[int],
    delivered: Set[int], links: Set[Link], direct: Set[int],
    running: Set[int], online: Set[int], guarded: bool,
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
  val state: State = { requested: requested, submitted: submitted, completed: completed, cancelled: cancelled, delivered: delivered, links: links, direct: direct, running: running, online: online, guarded: guarded }
  action update(after: State): bool = all {
    requested' = after.requested, submitted' = after.submitted, completed' = after.completed, cancelled' = after.cancelled, delivered' = after.delivered, links' = after.links, direct' = after.direct, running' = after.running, online' = after.online, guarded' = after.guarded
  }
  action init = all {
    requested' = Set(), submitted' = Set(), completed' = Set(), cancelled' = Set(),
    delivered' = Set(), links' = Set(), direct' = Set(), running' = Set(), online' = refs, guarded' = true,
  }
  action initUnsafe = all {
    requested' = Set(), submitted' = Set(), completed' = Set(), cancelled' = Set(),
    delivered' = Set(), links' = Set(), direct' = Set(), running' = Set(), online' = refs, guarded' = false,
  }
  def terminal(ref: int): bool = state.completed.contains(ref) or state.cancelled.contains(ref)
  def pending(ref: int): bool = state.requested.contains(ref) and not(terminal(ref))

  action request(ref: int): bool = all {
    ref.in(Set(0, 3)), state.online.contains(ref), not(state.requested.contains(ref)),
    update(state.with("requested", state.requested.union(Set(ref)))),
  }

  // own records acceptance and the executor's durable forwarding address before work can start.
  action own(link: Link): bool = all {
    link.in(possibleLinks), state.online.contains(link._1), pending(link._1),
    not(state.requested.contains(link._2)),
    update(state.with("links", state.links.union(Set(link)))
      .with("requested", state.requested.union(Set(link._2)))),
  }

  action start(ref: int): bool = all {
    state.online.contains(ref), pending(ref), not(state.running.contains(ref)),
    update(state.with("running", state.running.union(Set(ref)))),
  }

  // submit preserves an accepted deferred handle even if cancellation won while submission was running.
  action submit(ref: int): bool = all {
    state.online.contains(ref), state.running.contains(ref), not(state.completed.contains(ref)),
    update(state.with("submitted", state.submitted.union(Set(ref)))
      .with("running", state.running.exclude(Set(ref)))),
  }

  // finish accepts a result only while its immediate reference remains pending.
  action finish(ref: int): bool = all {
    state.online.contains(ref), state.requested.contains(ref),
    state.running.contains(ref) or state.submitted.contains(ref),
    not(state.guarded) or not(state.cancelled.contains(ref)),
    update(state.with("completed", state.completed.union(Set(ref)))
      .with("running", state.running.exclude(Set(ref)))),
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

  action abort(ref: int): bool = all {
    state.online.contains(ref), state.cancelled.contains(ref), state.running.contains(ref),
    update(state.with("running", state.running.exclude(Set(ref)))),
  }

  action crash(ref: int): bool = all {
    state.online.contains(ref),
    update(state.with("online", state.online.exclude(Set(ref))).with("running", state.running.exclude(Set(ref)))),
  }

  // reopen retains durable cancellation and ownership; start cannot restart cancelled references.
  action reopen(ref: int): bool = all {
    not(state.online.contains(ref)), update(state.with("online", state.online.union(Set(ref)))),
  }

  action step = {
    nondet ref = refs.oneOf()
    nondet link = possibleLinks.oneOf()
    any { request(ref), own(link), start(ref), submit(ref), finish(ref), deliver(ref),
      cancel(ref), forward(link), abort(ref), crash(ref), reopen(ref), update(state) }
  }

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
    terminalExclusive, deliverySound, ownershipSound, cancellationIsolation, submissionPreserved,
  }

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
