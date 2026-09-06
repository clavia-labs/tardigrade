------------------------------ MODULE Method ------------------------------
(* Method models unary responses derived from a declared method and the link accepted with its call. Intermediate coordination is another call with its own identity. *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Addresses, Calls, Methods, CallLink, CallMethod, CallTimeout

Links == Addresses \X Addresses

ASSUME CallLink \in [Calls -> Links]
ASSUME CallMethod \in [Calls -> Methods]
ASSUME CallTimeout \in [Calls -> Nat]
ASSUME \A call \in Calls: CallTimeout[call] > 0

Source(link) == link[1]
Target(link) == link[2]
Reverse(link) == <<Target(link), Source(link)>>

ModelAddresses == {"parent", "child"}
ModelCalls == {"child-run", "budget-request"}
ModelMethods == {"message", "requestBudget"}
ModelCallLink == [call \in ModelCalls |->
  CASE call = "child-run" -> <<"parent", "child">>
    [] OTHER -> <<"child", "parent">>]
ModelCallMethod == [call \in ModelCalls |->
  CASE call = "child-run" -> "message"
    [] OTHER -> "requestBudget"]
ModelCallTimeout == [call \in ModelCalls |->
  CASE call = "child-run" -> 2
    [] OTHER -> 1]

VARIABLES requested, sent, accepted, terminal, failed, responded, delivered, responses,
          deadlines, now, alarms, timedOut

vars == <<requested, sent, accepted, terminal, failed, responded, delivered, responses,
          deadlines, now, alarms, timedOut>>

TypeOK ==
  /\ requested \subseteq Calls
  /\ sent \subseteq Calls
  /\ accepted \subseteq Calls
  /\ terminal \subseteq accepted
  /\ failed \subseteq terminal
  /\ responded \subseteq terminal
  /\ delivered \subseteq responded
  /\ responses \subseteq Calls \X Methods \X Links
  /\ deadlines \in [Calls -> Nat]
  /\ now \in Nat
  /\ alarms \subseteq Nat
  /\ timedOut \subseteq sent

Init ==
  /\ requested = {}
  /\ sent = {}
  /\ accepted = {}
  /\ terminal = {}
  /\ failed = {}
  /\ responded = {}
  /\ delivered = {}
  /\ responses = {}
  /\ deadlines = [call \in Calls |-> 0]
  /\ now = 0
  /\ alarms = {}
  /\ timedOut = {}

Request(call) ==
  /\ call \notin requested
  /\ requested' = requested \cup {call}
  /\ UNCHANGED <<sent, accepted, terminal, failed, responded, delivered, responses,
                  deadlines, now, alarms, timedOut>>

Send(call) ==
  /\ call \in requested
  /\ call \notin sent
  /\ sent' = sent \cup {call}
  /\ deadlines' = [deadlines EXCEPT ![call] = now + CallTimeout[call]]
  /\ UNCHANGED <<requested, accepted, terminal, failed, responded, delivered, responses,
                  now, alarms, timedOut>>

Accept(call) ==
  /\ call \in sent
  /\ call \notin accepted
  /\ accepted' = accepted \cup {call}
  /\ UNCHANGED <<requested, sent, terminal, failed, responded, delivered, responses,
                  deadlines, now, alarms, timedOut>>

Resolve(call) ==
  /\ call \in accepted
  /\ call \notin terminal
  /\ terminal' = terminal \cup {call}
  /\ \/ failed' = failed
     \/ failed' = failed \cup {call}
  /\ UNCHANGED <<requested, sent, accepted, responded, delivered, responses,
                  deadlines, now, alarms, timedOut>>

Respond(call) ==
  /\ call \in terminal
  /\ call \notin responded
  /\ responded' = responded \cup {call}
  /\ responses' = responses \cup {<<call, CallMethod[call], Reverse(CallLink[call])>>}
  /\ UNCHANGED <<requested, sent, accepted, terminal, failed, delivered,
                  deadlines, now, alarms, timedOut>>

Deliver(call) ==
  /\ call \in responded
  /\ call \notin delivered
  /\ call \notin timedOut
  /\ delivered' = delivered \cup {call}
  /\ UNCHANGED <<requested, sent, accepted, terminal, failed, responded, responses,
                  deadlines, now, alarms, timedOut>>

PendingCalls == sent \ (delivered \cup timedOut)
PendingDeadlines == {deadlines[call]: call \in PendingCalls}
EarliestDeadline == CHOOSE deadline \in PendingDeadlines:
  \A other \in PendingDeadlines: deadline <= other

(* The host multiplexes every open call onto its earliest physical alarm. Firing records the
   observed time; Timeout is the pure method consequence of that durable fact. *)
FireAlarm ==
  /\ PendingCalls # {}
  /\ EarliestDeadline \notin alarms
  /\ now <= EarliestDeadline
  /\ now' = EarliestDeadline
  /\ alarms' = alarms \cup {EarliestDeadline}
  /\ UNCHANGED <<requested, sent, accepted, terminal, failed, responded, delivered,
                  responses, deadlines, timedOut>>

Timeout(call) ==
  /\ call \in PendingCalls
  /\ deadlines[call] <= now
  /\ now \in alarms
  /\ timedOut' = timedOut \cup {call}
  /\ UNCHANGED <<requested, sent, accepted, terminal, failed, responded, delivered,
                  responses, deadlines, now, alarms>>

Next ==
  \/ \E call \in Calls: Request(call)
  \/ \E call \in Calls: Send(call)
  \/ \E call \in Calls: Accept(call)
  \/ \E call \in Calls: Resolve(call)
  \/ \E call \in Calls: Respond(call)
  \/ \E call \in Calls: Deliver(call)

AlarmNext ==
  \/ Next
  \/ FireAlarm
  \/ \E call \in Calls: Timeout(call)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ \A call \in Calls: WF_vars(Send(call))
  /\ \A call \in Calls: WF_vars(Accept(call))
  /\ \A call \in Calls: WF_vars(Resolve(call))
  /\ \A call \in Calls: WF_vars(Respond(call))
  /\ \A call \in Calls: WF_vars(Deliver(call))

NoDeadlineSpec ==
  /\ Spec
  /\ \A call \in Calls: WF_vars(Send(call))
  /\ \A call \in Calls: WF_vars(Accept(call))
  /\ \A call \in Calls: WF_vars(Respond(call))
  /\ \A call \in Calls: WF_vars(Deliver(call))

AlarmSpec ==
  /\ Init /\ [][AlarmNext]_vars
  /\ \A call \in Calls: WF_vars(Send(call))
  /\ \A call \in Calls: WF_vars(Accept(call))
  /\ \A call \in Calls: WF_vars(Respond(call))
  /\ \A call \in Calls: WF_vars(Deliver(call))
  /\ WF_vars(FireAlarm)
  /\ \A call \in Calls: WF_vars(Timeout(call))

ResponseReversesAcceptedLink ==
  \A response \in responses:
    response[3] = Reverse(CallLink[response[1]])

ResponseMatchesMethod ==
  \A response \in responses:
    response[2] = CallMethod[response[1]]

ResponseRequiresTerminalCall ==
  responded \subseteq accepted /\ responded \subseteq terminal

CallFollowsProtocol ==
  accepted \subseteq sent /\ sent \subseteq requested

AtMostOneResponsePerCall ==
  \A call \in Calls: Cardinality({response \in responses: response[1] = call}) <= 1

AtMostOneCallerTerminal == delivered \cap timedOut = {}

DispatchedCallsHaveDeadlines ==
  \A call \in sent: deadlines[call] > 0

AlarmsFireAtDeadlines == alarms \subseteq {deadlines[call]: call \in sent}

ClockRecordsAlarmFirings == now = 0 \/ now \in alarms

TimedOutCallsCrossedDeadline ==
  \A call \in timedOut: deadlines[call] <= now

ResponseReturnsToSource ==
  \A response \in responses:
    Target(response[3]) = Source(CallLink[response[1]])

AllTerminalCallsRespond ==
  \A call \in Calls:
    call \in terminal ~> call \in delivered

AllRequestedCallsRespond ==
  \A call \in Calls:
    call \in requested ~> call \in delivered

AllDispatchedCallsTerminate ==
  \A call \in Calls:
    call \in sent ~> (call \in delivered \/ call \in timedOut)

HintRespond(call, method, target) ==
  /\ call \in terminal
  /\ call \notin responded
  /\ responded' = responded \cup {call}
  /\ responses' = responses \cup {<<call, method, <<Target(CallLink[call]), target>>>>}
  /\ UNCHANGED <<requested, sent, accepted, terminal, failed, delivered,
                  deadlines, now, alarms, timedOut>>

HintNext ==
  \/ \E call \in Calls: Request(call)
  \/ \E call \in Calls: Send(call)
  \/ \E call \in Calls: Accept(call)
  \/ \E call \in Calls: Resolve(call)
  \/ \E call \in Calls, method \in Methods, target \in Addresses: HintRespond(call, method, target)
  \/ \E call \in Calls: Deliver(call)

HintSpec == Init /\ [][HintNext]_vars

=============================================================================
