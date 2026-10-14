// obligation defines attempts shared by execution and cleanup (workLifecycle.qnt, invariant).
// Identity and serialized input belong to the containing operation; retries preserve both.
// Attempt admission, outcome recording, and stop acknowledgement are atomic durable transitions.
// phase and result are volatile; crash loses them without replenishing the durable attempt budget.
// Timeout records an outcome without acknowledging producer quiescence.
module obligation {
  type Work = {
    owed: bool, attempts: int, pending: bool, quiescent: bool,
    phase: str, result: str, outcomes: int -> str, blocked: str,
  }
  pure val outcomes = Set("success", "failure", "died", "timeout")
  pure val phases = Set("idle", "running", "hung", "ready")
  pure val initial: Work = {
    owed: false, attempts: 0, pending: false, quiescent: true,
    phase: "idle", result: "", outcomes: Map(), blocked: "",
  }
  pure def accept(work: Work): Work = work.with("owed", true)
  pure def needsInput(work: Work): bool = work.owed or work.pending or not(work.quiescent)
  pure def mayBegin(work: Work, limit: int): bool = work.owed and not(work.pending)
    and work.quiescent and work.blocked == "" and work.attempts < limit
  // begin charges the attempt before execution; its number remains stable until outcome recording.
  pure def begin(work: Work): Work = work.with("attempts", work.attempts + 1)
    .with("pending", true).with("quiescent", false).with("phase", "running")
  pure def mayReturn(work: Work): bool = work.pending and work.phase == "running"
  pure def complete(work: Work, outcome: str): Work = work.with("phase", "ready").with("result", outcome)
  // discharges specializes logical completion; cleanup requires success while execution accepts terminal failure.
  pure def discharges(kind: str, outcome: str): bool = outcome == "success" or (kind == "execution" and outcomes.contains(outcome))
  pure def record(work: Work, kind: str, limit: int): Work = work
    .with("outcomes", work.outcomes.put(work.attempts, work.result)).with("pending", false)
    .with("owed", work.owed and not(discharges(kind, work.result)))
    .with("quiescent", true).with("phase", "idle").with("result", "")
    .with("blocked", if (work.owed and not(discharges(kind, work.result)))
      (if (work.result == "died") "died" else if (work.attempts >= limit) "budget" else "") else "")
  // timeout preserves producer uncertainty and prevents another attempt until stop acknowledgement.
  pure def timeout(work: Work, kind: str): Work = work
    .with("outcomes", work.outcomes.put(work.attempts, "timeout")).with("pending", false)
    .with("owed", work.owed and not(discharges(kind, "timeout")))
    .with("phase", "idle").with("result", "").with("blocked", "timeout")
  // acknowledgeStop records producer quiescence independently of the attempt outcome.
  pure def acknowledgeStop(work: Work): Work = work.with("quiescent", true).with("phase", "idle").with("result", "")
  pure def crash(work: Work): Work = work.with("phase", "idle").with("result", "")
  pure def resume(work: Work, limit: int): Work = work.with("blocked", if (work.attempts >= limit) "budget" else "")
  pure def wellFormed(work: Work, limit: int): bool = all {
    work.attempts.in(0.to(limit)), work.phase.in(phases), work.result.in(outcomes.union(Set(""))),
    work.blocked.in(Set("", "budget", "died", "timeout")),
    work.outcomes.keys().subseteq(1.to(work.attempts)), work.outcomes.keys().forall(attempt => outcomes.contains(work.outcomes.get(attempt))),
    work.pending implies work.attempts > 0 and not(work.outcomes.keys().contains(work.attempts)),
    not(work.pending) implies work.outcomes.keys() == 1.to(work.attempts),
    work.pending implies work.outcomes.keys() == 1.to(work.attempts - 1),
    work.phase.in(Set("running", "hung", "ready")) implies work.pending,
    (work.phase == "ready") == (work.result != ""),
    work.phase.in(Set("running", "hung")) implies not(work.quiescent),
    work.blocked == "budget" implies work.owed and work.attempts == limit,
  }
}
