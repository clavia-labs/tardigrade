----------------------------- MODULE Thread -----------------------------
(* Thread models the first durable delivery to one actor instance. The delivery carries lineage, and the target log accepts that lineage once while committing ThreadCreated and the first message together. Thread names are opaque. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Threads, Requests, TargetOf, ParentOf, DepthOf, MaxAttempts, MaxDepth, None

ASSUME TargetOf \in [Requests -> Threads]
ASSUME ParentOf \in [Requests -> Threads \cup {None}]
ASSUME MaxDepth \in Nat
ASSUME DepthOf \in [Requests -> 0..MaxDepth]
ASSUME None \notin Threads
ASSUME MaxAttempts \in Nat /\ MaxAttempts > 0

ModelThreads == {"root", "left", "right", "child"}
ModelRequests == {"root-request", "left-request", "right-request", "child-left", "child-right", "forged"}
ModelTarget == [request \in ModelRequests |->
  CASE request = "root-request" -> "root"
    [] request = "left-request" -> "left"
    [] request = "right-request" -> "right"
    [] OTHER -> "child"]
ModelParent == [request \in ModelRequests |->
  CASE request = "root-request" -> None
    [] request \in {"left-request", "right-request"} -> "root"
    [] request \in {"child-left", "forged"} -> "left"
    [] OTHER -> "right"]
ModelDepth == [request \in ModelRequests |->
  CASE request = "root-request" -> 0
    [] request \in {"left-request", "right-request"} -> 1
    [] request \in {"child-left", "child-right"} -> 2
    [] OTHER -> 7]

CreatedEvent(thread, parent, depth) == <<"ThreadCreated", thread, parent, depth>>
MessageEvent(request) == <<"MessageReceived", request>>
Values(sequence) == {sequence[index] : index \in DOMAIN sequence}

VARIABLES sent, pending, accepted, rejected, created, recordedParent, recordedDepth, logs, attempts

vars == <<sent, pending, accepted, rejected, created, recordedParent, recordedDepth, logs, attempts>>

TypeOK ==
  /\ sent \subseteq Requests
  /\ pending \subseteq sent
  /\ accepted \subseteq sent
  /\ rejected \subseteq sent
  /\ accepted \cap rejected = {}
  /\ created \subseteq Threads
  /\ recordedParent \in [Threads -> Threads \cup {None}]
  /\ recordedDepth \in [Threads -> Nat]
  /\ logs \in [Threads -> Seq(
       {CreatedEvent(thread, parent, depth) : thread \in Threads, parent \in Threads \cup {None}, depth \in 0..MaxDepth}
       \cup {MessageEvent(request) : request \in Requests})]
  /\ attempts \in [Requests -> 0..MaxAttempts]

Init ==
  /\ sent = {}
  /\ pending = {}
  /\ accepted = {}
  /\ rejected = {}
  /\ created = {}
  /\ recordedParent = [thread \in Threads |-> None]
  /\ recordedDepth = [thread \in Threads |-> 0]
  /\ logs = [thread \in Threads |-> <<>>]
  /\ attempts = [request \in Requests |-> 0]

(* ParentReady permits a root request or a child request from an existing thread. *)
ParentReady(request) == ParentOf[request] = None \/ ParentOf[request] \in created

(* ValidLineage accepts roots at depth zero and children one level below their recorded parent. *)
ValidLineage(request) ==
  LET target == TargetOf[request]
      parent == ParentOf[request]
      depth == DepthOf[request]
  IN IF parent = None
     THEN depth = 0
     ELSE parent \in created /\ parent # target /\ depth = recordedDepth[parent] + 1

MatchesCreated(request) ==
  LET target == TargetOf[request]
  IN ParentOf[request] = recordedParent[target] /\ DepthOf[request] = recordedDepth[target]

(* Submit places an initial delivery in flight only after its claimed parent exists. *)
Submit(request) ==
  /\ request \notin sent
  /\ ParentReady(request)
  /\ sent' = sent \cup {request}
  /\ pending' = pending \cup {request}
  /\ UNCHANGED <<accepted, rejected, created, recordedParent, recordedDepth, logs, attempts>>

(* Commit creates an absent target and lands its first message in one append. A matching retry is absorbed. A conflicting or invalid descriptor is rejected. *)
Commit(request) ==
  LET target == TargetOf[request]
      parent == ParentOf[request]
      depth == DepthOf[request]
      message == MessageEvent(request)
      fresh == target \notin created /\ ValidLineage(request)
      matching == target \in created /\ MatchesCreated(request)
  IN
    /\ request \in pending
    /\ attempts[request] < MaxAttempts
    /\ IF fresh
       THEN /\ created' = created \cup {target}
            /\ recordedParent' = [recordedParent EXCEPT ![target] = parent]
            /\ recordedDepth' = [recordedDepth EXCEPT ![target] = depth]
            /\ logs' = [logs EXCEPT ![target] = Append(Append(@, CreatedEvent(target, parent, depth)), message)]
            /\ accepted' = accepted \cup {request}
            /\ rejected' = rejected
       ELSE IF matching
            THEN /\ created' = created
                 /\ recordedParent' = recordedParent
                 /\ recordedDepth' = recordedDepth
                 /\ logs' = [logs EXCEPT ![target] = IF message \in Values(@) THEN @ ELSE Append(@, message)]
                 /\ accepted' = accepted \cup {request}
                 /\ rejected' = rejected
            ELSE /\ created' = created
                 /\ recordedParent' = recordedParent
                 /\ recordedDepth' = recordedDepth
                 /\ logs' = logs
                 /\ accepted' = accepted
                 /\ rejected' = rejected \cup {request}
    /\ pending' = pending \ {request}
    /\ attempts' = [attempts EXCEPT ![request] = @ + 1]
    /\ UNCHANGED sent

(* Retry redelivers an accepted request within the configured attempt bound. *)
Retry(request) ==
  /\ request \in accepted
  /\ request \notin pending
  /\ attempts[request] < MaxAttempts
  /\ pending' = pending \cup {request}
  /\ UNCHANGED <<sent, accepted, rejected, created, recordedParent, recordedDepth, logs, attempts>>

Next ==
  \/ \E request \in Requests: Submit(request)
  \/ \E request \in Requests: Commit(request)
  \/ \E request \in Requests: Retry(request)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ \A request \in Requests: WF_vars(Commit(request))

(* CreationOnce states that an existing thread has one creation event and an absent thread has none. *)
CreationOnce ==
  \A thread \in Threads:
    Cardinality({index \in DOMAIN logs[thread]: logs[thread][index][1] = "ThreadCreated"}) = IF thread \in created THEN 1 ELSE 0

(* CreationFirst states that ThreadCreated identifies its target log and occupies its first position. *)
CreationFirst ==
  \A thread \in created:
    logs[thread][1] = CreatedEvent(thread, recordedParent[thread], recordedDepth[thread])

(* CreationAtomic states that the first accepted message lands in the same append as ThreadCreated. *)
CreationAtomic ==
  \A thread \in created:
    Len(logs[thread]) >= 2 /\ \E request \in accepted: TargetOf[request] = thread /\ logs[thread][2] = MessageEvent(request)

(* LineageValid states that roots have depth zero and each child is one level below an existing parent. *)
LineageValid ==
  \A thread \in created:
    IF recordedParent[thread] = None
    THEN recordedDepth[thread] = 0
    ELSE /\ recordedParent[thread] \in created
         /\ recordedParent[thread] # thread
         /\ recordedDepth[thread] = recordedDepth[recordedParent[thread]] + 1

(* AcceptedMatchesCreated states that accepted deliveries agree on one immutable creation descriptor. *)
AcceptedMatchesCreated ==
  \A request \in accepted:
    LET target == TargetOf[request]
    IN target \in created /\ ParentOf[request] = recordedParent[target] /\ DepthOf[request] = recordedDepth[target]

(* MessagesStayAtTarget states that every message is present only in its target log. *)
MessagesStayAtTarget ==
  \A thread \in Threads, request \in Requests:
    MessageEvent(request) \in Values(logs[thread]) => thread = TargetOf[request]

(* AcceptedExactlyLogged states that accepted deliveries and durable messages agree. *)
AcceptedExactlyLogged ==
  \A request \in Requests:
    request \in accepted <=> MessageEvent(request) \in Values(logs[TargetOf[request]])

(* MessagesAtMostOnce states that transport retries cannot append a message twice. *)
MessagesAtMostOnce ==
  \A thread \in Threads, request \in Requests:
    Cardinality({index \in DOMAIN logs[thread]: logs[thread][index] = MessageEvent(request)}) <= 1

(* AllSentSettle states that every submitted delivery is eventually accepted or rejected. *)
AllSentSettle ==
  \A request \in Requests: request \in sent ~> request \in accepted \cup rejected

(* CreateOnly exposes a split commit where ThreadCreated becomes visible before the first message. *)
CreateOnly(request) ==
  LET target == TargetOf[request]
      parent == ParentOf[request]
      depth == DepthOf[request]
  IN
    /\ request \in pending
    /\ target \notin created
    /\ ValidLineage(request)
    /\ created' = created \cup {target}
    /\ recordedParent' = [recordedParent EXCEPT ![target] = parent]
    /\ recordedDepth' = [recordedDepth EXCEPT ![target] = depth]
    /\ logs' = [logs EXCEPT ![target] = Append(@, CreatedEvent(target, parent, depth))]
    /\ UNCHANGED <<sent, pending, accepted, rejected, attempts>>

SplitNext ==
  \/ \E request \in Requests: Submit(request)
  \/ \E request \in Requests: CreateOnly(request)

SplitSpec == Init /\ [][SplitNext]_vars

(* TrustCommit accepts an unvalidated descriptor for an absent target. *)
TrustCommit(request) ==
  LET target == TargetOf[request]
      parent == ParentOf[request]
      depth == DepthOf[request]
  IN
    /\ request \in pending
    /\ target \notin created
    /\ created' = created \cup {target}
    /\ recordedParent' = [recordedParent EXCEPT ![target] = parent]
    /\ recordedDepth' = [recordedDepth EXCEPT ![target] = depth]
    /\ logs' = [logs EXCEPT ![target] = Append(Append(@, CreatedEvent(target, parent, depth)), MessageEvent(request))]
    /\ accepted' = accepted \cup {request}
    /\ pending' = pending \ {request}
    /\ attempts' = [attempts EXCEPT ![request] = @ + 1]
    /\ UNCHANGED <<sent, rejected>>

TrustNext ==
  \/ \E request \in Requests: Submit(request)
  \/ \E request \in Requests: TrustCommit(request)

TrustSpec == Init /\ [][TrustNext]_vars

(* OverwriteCommit accepts a competing parent by replacing the target's creation descriptor. *)
OverwriteCommit(request) ==
  LET target == TargetOf[request]
      parent == ParentOf[request]
      depth == DepthOf[request]
  IN
    /\ request \in pending
    /\ target \in created
    /\ ValidLineage(request)
    /\ ~MatchesCreated(request)
    /\ recordedParent' = [recordedParent EXCEPT ![target] = parent]
    /\ recordedDepth' = [recordedDepth EXCEPT ![target] = depth]
    /\ logs' = [logs EXCEPT ![target] = Append(Append(@, CreatedEvent(target, parent, depth)), MessageEvent(request))]
    /\ accepted' = accepted \cup {request}
    /\ pending' = pending \ {request}
    /\ attempts' = [attempts EXCEPT ![request] = @ + 1]
    /\ UNCHANGED <<sent, rejected, created>>

OverwriteNext ==
  \/ \E request \in Requests: Submit(request)
  \/ \E request \in Requests: Commit(request)
  \/ \E request \in Requests: OverwriteCommit(request)

OverwriteSpec == Init /\ [][OverwriteNext]_vars

=============================================================================
