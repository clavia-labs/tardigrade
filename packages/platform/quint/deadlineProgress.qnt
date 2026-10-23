// deadlineProgress models a deferred local deadline sharing its drain with another act (deadlineSettles, expiryCanProgress).
// Clock and alarm delivery are fair; the other execution may remain running indefinitely.
// init admits expiry from scheduler wakes; initSharedDrain reproduces expiry waiting behind an execution.
module deadlineProgress {
  type State = {
    mode: str, started: bool, otherRunning: bool, drain: str,
    expired: bool, wakeDelivered: bool, expiryQueued: bool, settled: bool, callback: bool,
    independentExpiry: bool,
  }
  pure def initial(mode: str, independentExpiry: bool): State = {
    mode: mode, started: false, otherRunning: false, drain: "ready",
    expired: false, wakeDelivered: false, expiryQueued: false, settled: false, callback: false,
    independentExpiry: independentExpiry,
  }
  var state: State
  action init = state' = initial("execution", true)
  action initSharedDrain = state' = initial("execution", false)
  action initNoOther = state' = initial("none", false)
  action initDeferredOther = state' = initial("producer", false)

  // startOther distinguishes an execution awaited by the drain from an already-deferred producer.
  action startOther = all {
    not(state.started),
    state' = state.with("started", true).with("otherRunning", state.mode != "none")
      .with("drain", if (state.mode == "execution") "waiting" else "ready"),
  }
  action tick = all {
    state.started, not(state.expired), state' = state.with("expired", true),
  }
  action fireAlarm = all {
    state.expired, not(state.wakeDelivered), state' = state.with("wakeDelivered", true),
  }
  // queueExpiry requires the drain to resume unless expiry has an independent admission path.
  action queueExpiry = all {
    state.wakeDelivered, not(state.expiryQueued), not(state.settled),
    state.drain == "ready" or state.independentExpiry,
    state' = state.with("expiryQueued", true),
  }
  action commitExpiry = all {
    state.expiryQueued, not(state.settled),
    state' = state.with("settled", true).with("expiryQueued", false),
  }
  action deliverCallback = all {
    state.settled, not(state.callback), state' = state.with("callback", true),
  }
  // finishOther is optional because external executions and producers need not terminate.
  action finishOther = all {
    state.otherRunning, state' = state.with("otherRunning", false).with("drain", "ready"),
  }
  action idle = state' = state
  action step = any { startOther, tick, fireAlarm, queueExpiry, commitExpiry, deliverCallback, finishOther, idle }

  val typeInvariant = all {
    state.mode.in(Set("none", "execution", "producer")), state.drain.in(Set("ready", "waiting")),
    state.drain == "waiting" implies state.otherRunning and state.mode == "execution",
    state.wakeDelivered implies state.expired,
    state.expiryQueued implies state.wakeDelivered and not(state.settled),
    state.settled implies state.expired and state.wakeDelivered,
    state.callback implies state.settled,
  }
  val expiryCanProgress = state.wakeDelivered and not(state.settled) implies
    state.expiryQueued or state.drain == "ready" or state.independentExpiry
  temporal fairService = startOther.weakFair(state) and tick.weakFair(state) and fireAlarm.weakFair(state)
    and queueExpiry.weakFair(state) and commitExpiry.weakFair(state) and deliverCallback.weakFair(state)
  temporal deadlineSettles = fairService implies state.expired.leadsTo(state.settled)
  temporal callbackDelivered = fairService implies state.expired.leadsTo(state.callback)

  run blockedDrainTest = initSharedDrain.then(startOther).then(tick).then(fireAlarm).then(idle)
    .expect(typeInvariant and state.otherRunning and not(state.settled) and not(expiryCanProgress))
  run releasedDrainTest = initSharedDrain.then(startOther).then(tick).then(fireAlarm).then(finishOther)
    .then(queueExpiry).then(commitExpiry).then(deliverCallback).expect(typeInvariant and state.callback)
  run noOtherTest = initNoOther.then(startOther).then(tick).then(fireAlarm)
    .then(queueExpiry).then(commitExpiry).then(deliverCallback).expect(typeInvariant and state.callback)
  run deferredOtherTest = initDeferredOther.then(startOther).then(tick).then(fireAlarm)
    .then(queueExpiry).then(commitExpiry).then(deliverCallback).expect(typeInvariant and state.callback and state.otherRunning)
  run independentExpiryTest = init.then(startOther).then(tick).then(fireAlarm)
    .then(queueExpiry).then(commitExpiry).then(deliverCallback).expect(typeInvariant and state.callback and state.otherRunning)
}
