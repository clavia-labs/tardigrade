// messageReply models accepted requests, durable reply obligations, delivery acts, and recipient acceptance.
// Acceptance records the obligation; terminal computation enables a reply act; acknowledged delivery discharges it.
// The sender stays online, the receiver crashes at most once, and platform wakes and enabled deliveries are weakly fair.
// initVolatile reproduces settlement without a durable obligation; a crash erases its best-effort reply intent.
// This abstraction checks the protocol; it does not prove TypeScript correspondence or transport durability.
// Run verification from a temporary directory to keep backend artifacts outside the repository.
// quint verify /absolute/path/to/messageReply.qnt --backend tlc --invariant invariant,replyRecoverable,obligationConserved --temporal requestProgress,obligationProgress
// quint verify /absolute/path/to/messageReply.qnt --backend tlc --init initVolatile --step stepWithoutCrash --temporal requestProgress
// quint verify /absolute/path/to/messageReply.qnt --backend tlc --init initVolatile --temporal requestProgress
module messageReply {
  type State = {
    sendRequested: bool, receiverAccepted: bool, sendSettled: bool,
    receiverSettled: bool, replyPending: bool, replyRequested: bool,
    replyAccepted: bool, replyCompleted: bool, obligation: bool,
    senderSettled: bool, receiverOnline: bool, crashed: bool, durableReplies: bool,
  }
  var state: State

  pure def initial(durable: bool): State = {
    sendRequested: false, receiverAccepted: false, sendSettled: false,
    receiverSettled: false, replyPending: false, replyRequested: false,
    replyAccepted: false, replyCompleted: false, obligation: false,
    senderSettled: false, receiverOnline: true, crashed: false, durableReplies: durable,
  }
  action init = state' = initial(true)
  action initVolatile = state' = initial(false)
  action startRequest = all {
    not(state.sendRequested), state' = state.with("sendRequested", true),
  }
  action acceptRequest = all {
    state.sendRequested, state.receiverOnline, not(state.receiverAccepted),
    state' = state.with("receiverAccepted", true).with("obligation", state.durableReplies),
  }
  action acknowledgeRequest = all {
    state.receiverAccepted, not(state.sendSettled), state' = state.with("sendSettled", true),
  }
  action settleReceiver = all {
    state.receiverOnline, state.receiverAccepted, not(state.receiverSettled),
    state' = state.with("receiverSettled", true).with("replyPending", true),
  }
  action requestReply = all {
    state.receiverOnline, state.receiverSettled, state.obligation, not(state.replyRequested),
    state' = state.with("replyRequested", true),
  }
  action deliverReply = all {
    state.receiverOnline, not(state.replyAccepted),
    state.replyRequested or (not(state.durableReplies) and state.replyPending),
    state' = state.with("replyAccepted", true).with("replyPending", false),
  }
  action completeReply = all {
    state.receiverOnline, state.replyRequested, state.replyAccepted, not(state.replyCompleted),
    state' = state.with("replyCompleted", true).with("obligation", false),
  }
  action settleSender = all {
    state.sendSettled, state.replyAccepted, not(state.senderSettled), state' = state.with("senderSettled", true),
  }
  action crash = all {
    state.receiverOnline, not(state.crashed),
    state' = state.with("receiverOnline", false).with("crashed", true).with("replyPending", false),
  }
  action reopen = all { not(state.receiverOnline), state' = state.with("receiverOnline", true) }
  action idle = state' = state
  action stepWithoutCrash = any {
    startRequest, acceptRequest, acknowledgeRequest, settleReceiver, requestReply, deliverReply, completeReply, settleSender, idle,
  }
  action step = any { stepWithoutCrash, crash, reopen }

  val invariant = all {
    state.receiverAccepted implies state.sendRequested,
    state.sendSettled implies state.receiverAccepted,
    state.receiverSettled implies state.receiverAccepted,
    state.replyPending implies (state.receiverSettled and not(state.replyAccepted)),
    state.replyRequested implies state.receiverSettled,
    state.replyAccepted implies state.receiverSettled,
    state.replyCompleted implies (state.replyRequested and state.replyAccepted),
    state.senderSettled implies (state.sendSettled and state.replyAccepted),
    state.obligation implies (state.receiverAccepted and not(state.replyCompleted)),
    not(state.receiverOnline) implies state.crashed,
  }
  val obligationConserved = (state.durableReplies and state.receiverAccepted and not(state.replyCompleted)) implies state.obligation
  val replyRecoverable = not(all {
    state.receiverOnline, state.receiverSettled, state.sendSettled,
    not(state.obligation), not(state.replyPending), not(state.replyRequested), not(state.replyAccepted), not(state.senderSettled),
  })
  temporal fairExecution =
    startRequest.weakFair(state) and acceptRequest.weakFair(state) and acknowledgeRequest.weakFair(state) and
    settleReceiver.weakFair(state) and requestReply.weakFair(state) and deliverReply.weakFair(state) and
    completeReply.weakFair(state) and settleSender.weakFair(state) and reopen.weakFair(state)
  temporal requestProgress = fairExecution implies state.receiverAccepted.leadsTo(state.senderSettled)
  temporal obligationProgress = fairExecution implies state.obligation.leadsTo(state.replyCompleted)
}
