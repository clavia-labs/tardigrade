// interpreterVersion models version adoption and fenced recovery budgets (invariant, eventualStop).
module interpreterVersion {
  type State = {
    deployed: int, adopted: int, budgetVersion: int, epoch: int, deployments: int,
    probeEpoch: int, probeVersion: int, probeFence: bool, attempts: int, chargedVersion: int, status: str, wake: bool, ticket: int, history: List[int],
    broken: Set[int], legacy: bool, resetSameVersion: bool, fence: bool, rearm: bool, renewPending: bool,
  }
  pure val maxAttempts = 2
  pure val maxDeployments = 2
  pure val initial = {
    deployed: 1, adopted: 1, budgetVersion: 1, epoch: 0, deployments: 0,
    probeEpoch: -1, probeVersion: 0, probeFence: true, attempts: 0, chargedVersion: 1, status: "pending", wake: true, ticket: -1, history: [1],
    broken: Set(1), legacy: false, resetSameVersion: false, fence: true, rearm: true, renewPending: true,
  }
  var state: State
  action init = state' = initial
  action initLegacy = state' = initial.with("adopted", 0).with("budgetVersion", 0).with("history", [0]).with("status", "blocked").with("wake", false).with("legacy", true).with("chargedVersion", 0)
  action initSameVersionReset = state' = initial.with("resetSameVersion", true)
  action initWithoutPendingRenewal = state' = initial.with("renewPending", false)
  action initStaleProbe = state' = initial.with("probeFence", false)
  action initUnfenced = state' = initial.with("fence", false)
  action initWithoutWake = state' = initial.with("rearm", false)
  action deploy = all {
    state.deployments < maxDeployments,
    nondet version = Set(1, 2).exclude(Set(state.deployed)).oneOf()
    state' = state.with("deployed", version).with("deployments", state.deployments + 1),
  }
  action activate = {
    val changed = state.adopted != state.deployed
    val renew = (state.status == "blocked" or (state.renewPending and state.status == "pending")) and (state.budgetVersion != state.deployed or state.resetSameVersion)
    state' = state.with("adopted", state.deployed)
      .with("history", if (changed) state.history.append(state.deployed) else state.history)
      .with("budgetVersion", state.deployed)
      .with("epoch", if (renew) state.epoch + 1 else state.epoch)
      .with("attempts", if (renew) 0 else state.attempts)
      .with("status", if (renew) "pending" else state.status)
      .with("wake", if (renew) state.rearm else state.wake)
  }
  action beginProbe = all {
    state.status == "pending", state.probeEpoch == -1,
    state' = state.with("probeEpoch", state.epoch).with("probeVersion", state.adopted),
  }
  action probeFailure = all {
    state.probeEpoch >= 0, state.status == "pending",
    val stale = state.probeEpoch != state.epoch or state.probeVersion != state.adopted
    state' = if (stale and state.probeFence) state.with("probeEpoch", -1)
      else state.with("probeEpoch", -1).with("ticket", state.epoch).with("attempts", if (state.attempts < maxAttempts) state.attempts + 1 else state.attempts).with("chargedVersion", state.probeVersion).with("status", "blocked").with("wake", false),
  }
  action fire = all {
    state.status == "pending", state.wake, state.adopted == state.deployed,
    state.attempts < maxAttempts,
    state' = state.with("attempts", state.attempts + 1).with("ticket", state.epoch)
      .with("budgetVersion", state.adopted).with("chargedVersion", state.adopted),
  }
  action recoveryFailure = all {
    state.ticket == state.epoch, state.chargedVersion == state.adopted, state.status == "pending", state.broken.contains(state.adopted),
    state' = state.with("status", "blocked").with("wake", false),
  }
  action succeed = all {
    state.ticket == state.epoch, state.chargedVersion == state.adopted, state.status == "pending", not(state.broken.contains(state.adopted)),
    state' = state.with("status", "settled").with("wake", false).with("ticket", -1),
  }
  action lateFailure = all {
    state.ticket >= 0, state.chargedVersion != state.adopted or state.ticket != state.epoch,
    state' = if (state.fence and state.ticket != state.epoch) state else state.with("status", "blocked").with("wake", false),
  }
  action exhausted = all {
    state.status == "pending", state.attempts >= maxAttempts,
    state' = state.with("status", "blocked").with("wake", false),
  }
  action crash = state' = state
  action idle = state' = state
  action step = any { deploy, activate, beginProbe, probeFailure, fire, recoveryFailure, succeed, lateFailure, exhausted, crash, idle }

  val boundedBudgets = state.epoch <= state.deployments + (if (state.legacy) 1 else 0) and state.attempts <= maxAttempts
  val wakeCoverage = state.status == "pending" implies state.wake
  val historyMatches = state.history.nth(state.history.length() - 1) == state.adopted and state.history.length() <= state.deployments + (if (state.legacy) 2 else 1)
  val freshBudgetPending = state.ticket >= 0 and state.ticket != state.epoch implies state.status == "pending"
  val newVersionCanRecover = state.status == "pending" and state.attempts >= maxAttempts and state.adopted == state.deployed implies state.chargedVersion == state.adopted
  val oldFailureFenced = state.status == "blocked" implies state.chargedVersion == state.adopted
  val invariant = all { oldFailureFenced, boundedBudgets, wakeCoverage, historyMatches, freshBudgetPending, newVersionCanRecover }
  temporal fairService = activate.weakFair(state) and fire.weakFair(state) and recoveryFailure.weakFair(state) and succeed.weakFair(state) and exhausted.weakFair(state)
  temporal eventualStop = fairService implies (state.status == "pending").leadsTo(state.status != "pending")

  run fixedVersionTest = init.then(fire).then(recoveryFailure).then(deploy).then(activate)
    .expect(state.status == "pending" and state.epoch == 1 and state.history == [1, 2])
    .then(lateFailure).then(fire).then(succeed).expect(state.status == "settled" and invariant)
  run finalPrechargeCrashTest = init.then(fire).then(fire).then(crash).then(deploy).then(activate)
    .expect(state.epoch == 1 and state.attempts == 0 and state.status == "pending" and invariant)
    .then(fire).then(succeed).expect(state.status == "settled")
  run pendingAdoptionTest = init.then(fire).then(deploy).then(activate)
    .expect(state.attempts == 0 and state.epoch == 1 and invariant)
    .then(lateFailure).expect(state.status == "pending" and invariant)
    .then(fire).then(succeed).expect(state.status == "settled")
  run staleProbeTest = init.then(beginProbe).then(deploy).then(activate).then(probeFailure)
    .expect(state.status == "pending" and state.attempts == 0 and invariant)
    .then(fire).then(succeed).expect(state.status == "settled")
  run sameVersionTest = init.then(fire).then(recoveryFailure).then(crash).then(activate)
    .expect(state.status == "blocked" and state.epoch == 0 and state.history == [1])
  run legacyTest = initLegacy.then(activate).expect(state.status == "pending" and state.epoch == 1 and state.budgetVersion == 1 and invariant)
  run stillBrokenTest = (state' = initial.with("broken", Set(1, 2)))
    .then(fire).then(recoveryFailure).then(deploy).then(activate).then(fire).then(recoveryFailure)
    .expect(state.status == "blocked" and state.budgetVersion == 2)
  run rollbackTest = (state' = initial.with("broken", Set(1, 2)))
    .then(fire).then(recoveryFailure).then(deploy).then(activate).then(fire).then(recoveryFailure).then(deploy).then(activate)
    .expect(state.adopted == 1 and state.epoch == 2 and state.history == [1, 2, 1] and invariant)
}
