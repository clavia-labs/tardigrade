----------------------------- MODULE Child -----------------------------
(* Child models the durable bridge from one parent call to one child thread. ChildCreated fixes the logical child in the parent log. Delivery uses that recorded address. The child accepts ThreadCreated and its initial message atomically. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Calls, Threads, ProposedTarget, RetryTarget, None

ASSUME ProposedTarget \in [Calls -> Threads]
ASSUME RetryTarget \in [Calls -> Threads]
ASSUME None \notin Threads
ASSUME \A left \in Calls, right \in Calls: ProposedTarget[left] = ProposedTarget[right] => left = right

ModelCalls == {"first", "second"}
ModelThreads == {"left", "right"}
ModelProposedTarget == [call \in ModelCalls |->
  CASE call = "first" -> "left"
    [] OTHER -> "right"]
ModelRetryTarget == [call \in ModelCalls |->
  CASE call = "first" -> "right"
    [] OTHER -> "left"]

ChildEvent(call, thread) == <<"ChildCreated", call, thread>>
ThreadEvent(call, thread) == <<"ThreadCreated", call, thread>>
MessageEvent(call) == <<"MessageReceived", call>>
Values(sequence) == {sequence[index] : index \in DOMAIN sequence}

VARIABLES requested, childOf, parentLog, deliveries, accepted, logs

vars == <<requested, childOf, parentLog, deliveries, accepted, logs>>

AssignedThreads == {thread \in Threads: \E call \in Calls: childOf[call] = thread}
Unused(thread) == thread \notin AssignedThreads

TypeOK ==
  /\ requested \subseteq Calls
  /\ childOf \in [Calls -> Threads \cup {None}]
  /\ parentLog \in Seq({ChildEvent(call, thread) : call \in Calls, thread \in Threads})
  /\ deliveries \subseteq Calls \X Threads
  /\ accepted \subseteq requested
  /\ logs \in [Threads -> Seq(
       {ThreadEvent(call, thread) : call \in Calls, thread \in Threads}
       \cup {MessageEvent(call) : call \in Calls})]

Init ==
  /\ requested = {}
  /\ childOf = [call \in Calls |-> None]
  /\ parentLog = <<>>
  /\ deliveries = {}
  /\ accepted = {}
  /\ logs = [thread \in Threads |-> <<>>]

(* Start records that a parent call requested a child. *)
Start(call) ==
  /\ call \notin requested
  /\ requested' = requested \cup {call}
  /\ UNCHANGED <<childOf, parentLog, deliveries, accepted, logs>>

(* Decide fixes one child address in the parent log. ProposedTarget is injective over calls. *)
Decide(call) ==
  LET target == ProposedTarget[call]
  IN
    /\ call \in requested
    /\ childOf[call] = None
    /\ Unused(target)
    /\ childOf' = [childOf EXCEPT ![call] = target]
    /\ parentLog' = Append(parentLog, ChildEvent(call, target))
    /\ UNCHANGED <<requested, deliveries, accepted, logs>>

(* Dispatch reads the address fixed by ChildCreated. Repeated execution cannot select another address. *)
Dispatch(call) ==
  LET target == childOf[call]
  IN
    /\ call \in requested
    /\ target # None
    /\ call \notin accepted
    /\ <<call, target>> \notin deliveries
    /\ deliveries' = deliveries \cup {<<call, target>>}
    /\ UNCHANGED <<requested, childOf, parentLog, accepted, logs>>

(* Accept initializes the child and lands its first message in one append. *)
Accept(call) ==
  LET target == childOf[call]
  IN
    /\ target # None
    /\ <<call, target>> \in deliveries
    /\ call \notin accepted
    /\ logs[target] = <<>>
    /\ logs' = [logs EXCEPT ![target] = <<ThreadEvent(call, target), MessageEvent(call)>>]
    /\ accepted' = accepted \cup {call}
    /\ UNCHANGED <<requested, childOf, parentLog, deliveries>>

Next ==
  \/ \E call \in Calls: Start(call)
  \/ \E call \in Calls: Decide(call)
  \/ \E call \in Calls: Dispatch(call)
  \/ \E call \in Calls: Accept(call)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ \A call \in Calls: WF_vars(Decide(call))
  /\ \A call \in Calls: WF_vars(Dispatch(call))
  /\ \A call \in Calls: WF_vars(Accept(call))

(* OneChildPerCall states that a parent call records at most one child. *)
OneChildPerCall ==
  \A call \in Calls:
    Cardinality({index \in DOMAIN parentLog: parentLog[index][2] = call}) <= 1

(* OneCallPerChild states that separate calls cannot share one child thread. *)
OneCallPerChild ==
  \A left \in Calls, right \in Calls:
    childOf[left] # None /\ childOf[left] = childOf[right] => left = right

(* ParentRecordMatches states that the parent log and its child lookup describe the same assignments. *)
ParentRecordMatches ==
  \A call \in Calls:
    childOf[call] = None
      <=> ~\E thread \in Threads: ChildEvent(call, thread) \in Values(parentLog)

(* DeliveryFollowsParent states that every delivery uses its call's recorded child address. *)
DeliveryFollowsParent ==
  \A call \in Calls, thread \in Threads:
    <<call, thread>> \in deliveries => childOf[call] = thread /\ ChildEvent(call, thread) \in Values(parentLog)

(* ThreadFollowsParent states that every initialized child has a matching parent record. *)
ThreadFollowsParent ==
  \A thread \in Threads:
    logs[thread] # <<>> => \E call \in Calls: childOf[call] = thread /\ ChildEvent(call, thread) \in Values(parentLog)

(* ChildMatchesParent states that the child's first event confirms the assignment in its parent. *)
ChildMatchesParent ==
  \A call \in accepted:
    LET thread == childOf[call]
    IN logs[thread][1] = ThreadEvent(call, thread)

(* CreationAtomic states that an initialized child contains its creation record and initial message together. *)
CreationAtomic ==
  \A thread \in Threads:
    logs[thread] # <<>> => Len(logs[thread]) = 2 /\ logs[thread][1][1] = "ThreadCreated" /\ logs[thread][2][1] = "MessageReceived"

(* InitialMessageAtMostOnce states that a retry cannot append the initial message twice. *)
InitialMessageAtMostOnce ==
  \A thread \in Threads, call \in Calls:
    Cardinality({index \in DOMAIN logs[thread]: logs[thread][index] = MessageEvent(call)}) <= 1

(* AllRequestsSettle states that each requested call eventually initializes one child. *)
AllRequestsSettle ==
  \A call \in Calls: call \in requested ~> call \in accepted

(* AllChildrenMaterialize states that each logical child eventually initializes its own log. *)
AllChildrenMaterialize ==
  \A call \in Calls: childOf[call] # None ~> call \in accepted

(* SendBeforeRecord exposes a child delivery before ChildCreated commits in the parent. *)
SendBeforeRecord(call) ==
  LET target == ProposedTarget[call]
  IN
    /\ call \in requested
    /\ childOf[call] = None
    /\ <<call, target>> \notin deliveries
    /\ deliveries' = deliveries \cup {<<call, target>>}
    /\ UNCHANGED <<requested, childOf, parentLog, accepted, logs>>

EarlyNext ==
  \/ \E call \in Calls: Start(call)
  \/ \E call \in Calls: SendBeforeRecord(call)

EarlySpec == Init /\ [][EarlyNext]_vars

(* RecomputeDispatch exposes a retry that asks placement for another address instead of reading ChildCreated. *)
RecomputeDispatch(call) ==
  LET target == RetryTarget[call]
  IN
    /\ childOf[call] # None
    /\ target # childOf[call]
    /\ <<call, target>> \notin deliveries
    /\ deliveries' = deliveries \cup {<<call, target>>}
    /\ UNCHANGED <<requested, childOf, parentLog, accepted, logs>>

RecomputeNext ==
  \/ Next
  \/ \E call \in Calls: RecomputeDispatch(call)

RecomputeSpec == Init /\ [][RecomputeNext]_vars

=============================================================================
