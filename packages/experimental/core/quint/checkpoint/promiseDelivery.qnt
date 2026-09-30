// promiseDelivery models early result delivery and admission retries (settlementFirst, batchExactlyOnce, deliveryProgress).
// One accepted effect successfully returns a deferred handle; its eventual result may fulfill or reject.
// Preparation does not publish EffectSettled; commitEffect makes it durable before PromiseSettled admission.
// The delivery batch contains a domain prefix, PromiseSettled, and a domain suffix; its cursor survives admission retries.
// retry represents host/src/runtime.ts send preserving its cursor; commitPromise represents core/src/event-log.ts validatePromise.
// Fair preparation, storage commit, and admission scheduling imply eventual acknowledgement without further crashes.
// Crashes, conflicting duplicate results, producer recovery, retry timer duration, and TypeScript refinement are outside this model.
// Apalache checks inductive safety; TLC exhaustively checks fair delivery progress for this finite instance.
// initUnsafe removes the promise admission guard and exposes premature delivery with settlementFirst.
// Run backend checks from a temporary directory so generated artifacts stay outside the repository.
// quint verify /absolute/path/to/promiseDelivery.qnt --inductive-invariant invariant --invariants settlementFirst batchExactlyOnce acknowledgementSound
// quint verify /absolute/path/to/promiseDelivery.qnt --backend tlc --invariant invariant --temporal deliveryProgress
// quint run /absolute/path/to/promiseDelivery.qnt --init initUnsafe --invariant settlementFirst --max-steps 12 --max-samples 1000 --seed 1
module promiseDelivery {
  type State = {
    phase: str, cursor: int, journalLength: int, effectPosition: int, promisePosition: int,
    beforeCount: int, promiseCount: int, afterCount: int, acknowledged: bool,
    guarded: bool, result: str,
  }
  pure val phases = Set("requested", "prepared", "settled")
  var phase: str
  var cursor: int
  var journalLength: int
  var effectPosition: int
  var promisePosition: int
  var beforeCount: int
  var promiseCount: int
  var afterCount: int
  var acknowledged: bool
  var guarded: bool
  var result: str
  val state: State = {
    phase: phase, cursor: cursor, journalLength: journalLength, effectPosition: effectPosition, promisePosition: promisePosition,
    beforeCount: beforeCount, promiseCount: promiseCount, afterCount: afterCount, acknowledged: acknowledged,
    guarded: guarded, result: result,
  }
  action update(after: State): bool = all {
    phase' = after.phase, cursor' = after.cursor, journalLength' = after.journalLength,
    effectPosition' = after.effectPosition, promisePosition' = after.promisePosition,
    beforeCount' = after.beforeCount, promiseCount' = after.promiseCount, afterCount' = after.afterCount,
    acknowledged' = after.acknowledged, guarded' = after.guarded, result' = after.result,
  }
  pure def initial(guard: bool, outcome: str): State = {
    phase: "requested", cursor: -1, journalLength: 1, effectPosition: -1, promisePosition: -1,
    beforeCount: 0, promiseCount: 0, afterCount: 0, acknowledged: false,
    guarded: guard, result: outcome,
  }
  action init = {
    nondet outcome = Set("fulfilled", "rejected").oneOf()
    val start = initial(true, outcome)
    all { phase' = start.phase, cursor' = start.cursor, journalLength' = start.journalLength, effectPosition' = start.effectPosition, promisePosition' = start.promisePosition, beforeCount' = start.beforeCount, promiseCount' = start.promiseCount, afterCount' = start.afterCount, acknowledged' = start.acknowledged, guarded' = start.guarded, result' = start.result }
  }
  action initUnsafe = {
    val start = initial(false, "fulfilled")
    all { phase' = start.phase, cursor' = start.cursor, journalLength' = start.journalLength, effectPosition' = start.effectPosition, promisePosition' = start.promisePosition, beforeCount' = start.beforeCount, promiseCount' = start.promiseCount, afterCount' = start.afterCount, acknowledged' = start.acknowledged, guarded' = start.guarded, result' = start.result }
  }

  action arrive = all { cursor == -1, update(state.with("cursor", 0)) }
  action prepareEffect = all { phase == "requested", update(state.with("phase", "prepared")) }
  action commitEffect = all {
    phase == "prepared",
    update(state.with("phase", "settled").with("effectPosition", journalLength).with("journalLength", journalLength + 1)),
  }
  action commitBefore = all {
    cursor == 0,
    update(state.with("beforeCount", beforeCount + 1).with("cursor", 1).with("journalLength", journalLength + 1)),
  }
  // retry releases admission while retaining the batch cursor and every committed record.
  action retry = all { cursor == 1, phase != "settled", guarded, update(state) }
  action commitPromise = all {
    cursor == 1, not(guarded) or phase == "settled",
    update(state.with("promiseCount", promiseCount + 1).with("promisePosition", journalLength)
      .with("cursor", 2).with("journalLength", journalLength + 1)),
  }
  action commitAfter = all {
    cursor == 2,
    update(state.with("afterCount", afterCount + 1).with("cursor", 3).with("journalLength", journalLength + 1)),
  }
  action acknowledge = all { cursor == 3, not(acknowledged), update(state.with("acknowledged", true)) }
  // duplicateDelivery accepts an identical settled result without another journal entry or domain follow-up.
  action duplicateDelivery = all { promiseCount == 1, update(state) }
  action stutter = update(state)
  action step = any { arrive, prepareEffect, commitEffect, commitBefore, retry, commitPromise, commitAfter, acknowledge, duplicateDelivery, stutter }

  val settlementFirst = promiseCount == 1 implies all {
    phase == "settled", effectPosition >= 1, effectPosition < promisePosition,
  }
  val batchExactlyOnce = all { beforeCount <= 1, promiseCount <= 1, afterCount <= 1 }
  val acknowledgementSound = acknowledged implies all {
    cursor == 3, beforeCount == 1, promiseCount == 1, afterCount == 1, settlementFirst,
  }
  val invariant = all {
    phase.in(phases), cursor.in((-1).to(3)), journalLength.in(1.to(5)),
    effectPosition.in((-1).to(4)), promisePosition.in((-1).to(4)),
    beforeCount.in(Set(0, 1)), promiseCount.in(Set(0, 1)), afterCount.in(Set(0, 1)),
    acknowledged.in(Set(false, true)), guarded == true, result.in(Set("fulfilled", "rejected")),
    beforeCount == (if (cursor >= 1) 1 else 0),
    promiseCount == (if (cursor >= 2) 1 else 0),
    afterCount == (if (cursor == 3) 1 else 0),
    (effectPosition == -1) == (phase != "settled"),
    (promisePosition == -1) == (promiseCount == 0),
    effectPosition < journalLength, promisePosition < journalLength,
    phase == "settled" implies effectPosition >= 1,
    promiseCount == 1 implies promisePosition >= 1,
    journalLength == 1 + beforeCount + promiseCount + afterCount + (if (phase == "settled") 1 else 0),
    settlementFirst, batchExactlyOnce, acknowledgementSound,
  }
  temporal deliveryProgress = (
    arrive.weakFair(state) and prepareEffect.weakFair(state) and commitEffect.weakFair(state)
    and commitBefore.weakFair(state) and commitPromise.weakFair(state)
    and commitAfter.weakFair(state) and acknowledge.weakFair(state)
  ) implies (not(acknowledged)).leadsTo(acknowledged)
}
