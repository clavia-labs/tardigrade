------------------------- MODULE ThreadCreation -------------------------
(* ThreadCreation models one child crossing the Actor DO directory and Thread DO log boundary. A ready directory entry is visible in the actor tree and therefore requires durable acceptance by its child. *)

EXTENDS FiniteSets, TLC

CONSTANTS Calls, Threads, Target, None

ASSUME Target \in [Calls -> Threads]
ASSUME None \notin Calls
ASSUME \A left \in Calls, right \in Calls: Target[left] = Target[right] => left = right

ModelCalls == {"first", "second"}
ModelThreads == {"left", "right"}
ModelTarget == [call \in ModelCalls |->
  CASE call = "first" -> "left"
    [] OTHER -> "right"]

States == {"absent", "pending", "ready"}

VARIABLES requested, directory, initialized, accepted, owner

vars == <<requested, directory, initialized, accepted, owner>>

TypeOK ==
  /\ requested \subseteq Calls
  /\ directory \in [Threads -> States]
  /\ initialized \subseteq Threads
  /\ accepted \subseteq Calls
  /\ owner \in [Threads -> Calls \cup {None}]

Init ==
  /\ requested = {}
  /\ directory = [thread \in Threads |-> "absent"]
  /\ initialized = {}
  /\ accepted = {}
  /\ owner = [thread \in Threads |-> None]

Start(call) ==
  /\ call \notin requested
  /\ requested' = requested \cup {call}
  /\ UNCHANGED <<directory, initialized, accepted, owner>>

(* CurrentInitialize creates the Thread DO identity before the Actor DO publishes its directory entry. *)
CurrentInitialize(call) ==
  LET thread == Target[call]
  IN
    /\ call \in requested
    /\ thread \notin initialized
    /\ initialized' = initialized \cup {thread}
    /\ UNCHANGED <<requested, directory, accepted, owner>>

(* CurrentPublish exposes a ready directory entry before the child accepts its creation event and initial message. *)
CurrentPublish(call) ==
  LET thread == Target[call]
  IN
    /\ thread \in initialized
    /\ directory[thread] = "absent"
    /\ directory' = [directory EXCEPT ![thread] = "ready"]
    /\ owner' = [owner EXCEPT ![thread] = call]
    /\ UNCHANGED <<requested, initialized, accepted>>

CurrentAccept(call) ==
  LET thread == Target[call]
  IN
    /\ directory[thread] = "ready"
    /\ call \notin accepted
    /\ accepted' = accepted \cup {call}
    /\ UNCHANGED <<requested, directory, initialized, owner>>

CurrentNext ==
  \/ \E call \in Calls: Start(call)
  \/ \E call \in Calls: CurrentInitialize(call)
  \/ \E call \in Calls: CurrentPublish(call)
  \/ \E call \in Calls: CurrentAccept(call)

CurrentSpec == Init /\ [][CurrentNext]_vars

(* Reserve records the actor-owned intent without exposing the child in the ready tree. *)
Reserve(call) ==
  LET thread == Target[call]
  IN
    /\ call \in requested
    /\ directory[thread] = "absent"
    /\ directory' = [directory EXCEPT ![thread] = "pending"]
    /\ owner' = [owner EXCEPT ![thread] = call]
    /\ UNCHANGED <<requested, initialized, accepted>>

(* Initialize creates the Thread DO identity while its directory reservation remains pending. *)
Initialize(call) ==
  LET thread == Target[call]
  IN
    /\ directory[thread] = "pending"
    /\ owner[thread] = call
    /\ thread \notin initialized
    /\ initialized' = initialized \cup {thread}
    /\ UNCHANGED <<requested, directory, accepted, owner>>

(* Accept durably lands ThreadCreated and the initial message before the actor publishes the child. *)
Accept(call) ==
  LET thread == Target[call]
  IN
    /\ directory[thread] = "pending"
    /\ owner[thread] = call
    /\ thread \in initialized
    /\ call \notin accepted
    /\ accepted' = accepted \cup {call}
    /\ UNCHANGED <<requested, directory, initialized, owner>>

(* Complete publishes only a child whose Thread DO has acknowledged durable acceptance. *)
Complete(call) ==
  LET thread == Target[call]
  IN
    /\ directory[thread] = "pending"
    /\ owner[thread] = call
    /\ call \in accepted
    /\ directory' = [directory EXCEPT ![thread] = "ready"]
    /\ UNCHANGED <<requested, initialized, accepted, owner>>

Next ==
  \/ \E call \in Calls: Start(call)
  \/ \E call \in Calls: Reserve(call)
  \/ \E call \in Calls: Initialize(call)
  \/ \E call \in Calls: Accept(call)
  \/ \E call \in Calls: Complete(call)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ \A call \in Calls: WF_vars(Reserve(call))
  /\ \A call \in Calls: WF_vars(Initialize(call))
  /\ \A call \in Calls: WF_vars(Accept(call))
  /\ \A call \in Calls: WF_vars(Complete(call))

(* ReadyHasAccepted states that every actor-visible child has durably accepted its creation. *)
ReadyHasAccepted ==
  \A thread \in Threads:
    directory[thread] = "ready" => owner[thread] \in accepted /\ Target[owner[thread]] = thread

(* AcceptedHasReservation states that every accepted child remains owned by its actor directory. *)
AcceptedHasReservation ==
  \A call \in accepted:
    directory[Target[call]] \in {"pending", "ready"} /\ owner[Target[call]] = call

(* PendingOwnsRequest states that every directory reservation belongs to a requested call. *)
PendingOwnsRequest ==
  \A thread \in Threads:
    directory[thread] = "pending" => owner[thread] \in requested

(* AllRequestsReady states that every requested child eventually becomes visible. *)
AllRequestsReady ==
  \A call \in Calls: call \in requested ~> directory[Target[call]] = "ready"

=============================================================================
