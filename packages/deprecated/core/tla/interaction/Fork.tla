------------------------------- MODULE Fork -------------------------------
(* Fork models a finite interaction tree, prefix forks, durable detachment, replies in flight, and bounded crashes. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Invocations, ParentOf, Destinations, MaxCrashes, Mode

ModelInvocations == {<<"actor", "main", "child", "work", "call", 0>>}
ModelEpochs == {<<"actor", "main", "child", "work", "call", epoch>> : epoch \in 0..1}
ModelParents == [i \in ModelEpochs |-> "parent"]
ModelDestinations == {"branch", "branch-again"}
ModelTreeDestinations == {"branch"}
ModelTreeInvocations == {<<"actor", "main", child, "work", "call", 0>> : child \in {"middle", "sibling", "leaf"}}
ModelTreeParents == [i \in ModelTreeInvocations |-> IF i[3] = "leaf" THEN "middle" ELSE "root"]
ModelChainInvocations == {i \in ModelTreeInvocations : i[3] # "sibling"}

ChildOf(i) == i[3]
Originals == {ParentOf[i] : i \in Invocations} \cup {ChildOf(i) : i \in Invocations}
ParentsOf(t) == {ParentOf[i] : i \in {edge \in Invocations : ChildOf(edge) = t}}

(* Ancestors bounds traversal by the original thread count so the tree assumption rejects cycles. *)
RECURSIVE Ancestors(_, _)
Ancestors(t, depth) == IF depth = 0 THEN {} ELSE
  ParentsOf(t) \cup UNION {Ancestors(parent, depth - 1) : parent \in ParentsOf(t)}
Threads == Originals \cup Destinations
ASSUME /\ IsFiniteSet(Invocations) /\ Invocations # {}
       /\ Invocations \subseteq DOMAIN ParentOf
       /\ (\A t \in Originals : Cardinality(ParentsOf(t)) <= 1 /\ t \notin Ancestors(t, Cardinality(Originals)))
       /\ Cardinality({t \in Originals : ParentsOf(t) = {}}) = 1
       /\ IsFiniteSet(Destinations) /\ Destinations \cap Originals = {}
       /\ MaxCrashes \in Nat
       /\ Mode \in {"correct", "no-incoming", "no-outgoing", "early", "volatile", "cross-delivery"}

Wait(i) == <<"Wait", i>>
Accept(i) == <<"Accept", i>>
Result(i) == <<"Result", i>>
Sent(i) == <<"Sent", i>>
DetachWait(i) == <<"InvocationDetached", "outgoing", i>>
DetachReply(i) == <<"InvocationDetached", "incoming", i>>
Done == <<"Done">>
Marker(source, seq, dest) == <<"ThreadForked", source, seq, dest>>
Values(log) == {log[n] : n \in DOMAIN log}
Has(log, event) == event \in Values(log)
Waits(log) == {i \in Invocations : Has(log, Wait(i)) /\ ~Has(log, Result(i)) /\ ~Has(log, DetachWait(i))}
Replies(log) == {i \in Invocations : Has(log, Accept(i)) /\ ~Has(log, Sent(i)) /\ ~Has(log, DetachReply(i))}

(* Ordered gives each finite event set a fixed append order so equivalent batches have the same durable trace. *)
RECURSIVE Ordered(_)
Ordered(events) == IF events = {} THEN <<>> ELSE
  LET event == CHOOSE e \in events : TRUE
  IN <<event>> \o Ordered(events \ {event})

InitialLog(t) == Ordered(
  {Wait(i) : i \in {edge \in Invocations : ParentOf[edge] = t}}
  \cup {Accept(i) : i \in {edge \in Invocations : ChildOf(edge) = t}})
Detachments(log) == {DetachWait(i) : i \in Waits(log)} \cup {DetachReply(i) : i \in Replies(log)}
ForkImage(prefix, source, seq, dest) == prefix \o <<Marker(source, seq, dest)>> \o Ordered(Detachments(prefix))
StoredImage(prefix, source, seq, dest) ==
  LET detach == CASE Mode = "no-incoming" -> {DetachWait(i) : i \in Waits(prefix)}
                 [] Mode = "no-outgoing" -> {DetachReply(i) : i \in Replies(prefix)}
                 [] Mode = "early" -> {}
                 [] OTHER -> Detachments(prefix)
  IN prefix \o <<Marker(source, seq, dest)>> \o Ordered(detach)

VARIABLES logs, created, online, images, requests, pending, sends, crashes
vars == <<logs, created, online, images, requests, pending, sends, crashes>>

Init ==
  /\ logs = [t \in Threads |-> InitialLog(t)]
  /\ created = Originals
  /\ online = Originals
  /\ images = [t \in Destinations |-> <<>>]
  /\ requests = [t \in Destinations |-> <<>>]
  /\ pending = {}
  /\ sends = {}
  /\ crashes = 0

(* CreateFork publishes a checkpoint under a fresh identity with local detachments in the same commit. images is a specification witness of the required commit, not a runtime store. *)
CreateFork(source, dest, seq) ==
  /\ source \in created \cap online
  /\ dest \in Destinations \ created
  /\ seq \in 1..Len(logs[source])
  /\ LET prefix == SubSeq(logs[source], 1, seq)
     IN /\ logs' = [logs EXCEPT ![dest] = StoredImage(prefix, source, seq, dest)]
        /\ images' = [images EXCEPT ![dest] = ForkImage(prefix, source, seq, dest)]
  /\ requests' = [requests EXCEPT ![dest] = <<source, seq>>]
  /\ created' = created \cup {dest}
  /\ online' = online \cup {dest}
  /\ UNCHANGED <<pending, sends, crashes>>

(* Finish abstracts terminating local work after every outgoing wait has a result or a detached outcome. *)
Finish(t) ==
  /\ t \in created \cap online
  /\ Waits(logs[t]) = {}
  /\ ~Has(logs[t], Done)
  /\ logs' = [logs EXCEPT ![t] = Append(@, Done)]
  /\ UNCHANGED <<created, online, images, requests, pending, sends, crashes>>

(* Send discharges one active incoming reply obligation and leaves its message in flight. *)
Send(t, i) ==
  /\ t \in created \cap online
  /\ i \in Replies(logs[t])
  /\ Has(logs[t], Done)
  /\ logs' = [logs EXCEPT ![t] = Append(@, Sent(i))]
  /\ pending' = pending \cup {<<t, i>>}
  /\ sends' = sends \cup {<<t, i>>}
  /\ UNCHANGED <<created, online, images, requests, crashes>>

(* Deliver addresses each invocation's original parent and matches its complete coordinate. *)
Deliver(t, i) ==
  /\ <<t, i>> \in pending
  /\ ParentOf[i] \in online
  /\ logs' = IF t = ChildOf(i) /\ i \in Waits(logs[ParentOf[i]])
              THEN [logs EXCEPT ![ParentOf[i]] = Append(@, Result(i))]
              ELSE logs
  /\ pending' = pending \ {<<t, i>>}
  /\ UNCHANGED <<created, online, images, requests, sends, crashes>>

(* Misdeliver models a reply accepted by another parent in the tree (ForkTreeCrossDelivery.cfg). *)
Misdeliver(t, i, receiver) ==
  /\ Mode = "cross-delivery"
  /\ <<t, i>> \in pending
  /\ receiver \in Originals \cap online
  /\ receiver # ParentOf[i]
  /\ logs' = [logs EXCEPT ![receiver] = Append(@, Result(i))]
  /\ pending' = pending \ {<<t, i>>}
  /\ UNCHANGED <<created, online, images, requests, sends, crashes>>

(* Crash preserves durable events except in the volatile-detachment counterexample. *)
Crash(t) ==
  /\ t \in online
  /\ crashes < MaxCrashes
  /\ online' = online \ {t}
  /\ crashes' = crashes + 1
  /\ logs' = IF Mode = "volatile" /\ t \in Destinations
              THEN [logs EXCEPT ![t] = SelectSeq(@, LAMBDA e : e[1] # "InvocationDetached")]
              ELSE logs
  /\ UNCHANGED <<created, images, requests, pending, sends>>

Recover(t) ==
  /\ t \in created \ online
  /\ online' = online \cup {t}
  /\ UNCHANGED <<logs, created, images, requests, pending, sends, crashes>>

(* Repair models detachments appended after an early publication has already exposed the fork. *)
Repair(t) ==
  /\ Mode = "early"
  /\ t \in created \cap Destinations \cap online
  /\ Detachments(logs[t]) # {}
  /\ logs' = [logs EXCEPT ![t] = @ \o Ordered(Detachments(@))]
  /\ UNCHANGED <<created, online, images, requests, pending, sends, crashes>>

Next ==
  \/ \E source \in Threads, dest \in Destinations : \E seq \in 1..Len(logs[source]) : CreateFork(source, dest, seq)
  \/ \E t \in Threads : Finish(t) \/ Crash(t) \/ Recover(t)
  \/ \E t \in Threads, i \in Invocations : Send(t, i) \/ Deliver(t, i)
  \/ \E t \in Destinations : Repair(t)
  \/ \E t \in Threads, i \in Invocations, receiver \in Originals : Misdeliver(t, i, receiver)
Spec == Init /\ [][Next]_vars
LiveSpec == Spec
  /\ (\A t \in Threads : WF_vars(Recover(t)) /\ WF_vars(Finish(t)))
  /\ (\A t \in Threads, i \in Invocations : WF_vars(Send(t, i)) /\ WF_vars(Deliver(t, i)))

MaxLog == 4 * Cardinality(Invocations) + Cardinality(Destinations) + 1
Events == {Wait(i) : i \in Invocations} \cup {Accept(i) : i \in Invocations}
       \cup {Result(i) : i \in Invocations} \cup {Sent(i) : i \in Invocations}
       \cup {DetachWait(i) : i \in Invocations} \cup {DetachReply(i) : i \in Invocations} \cup {Done}
       \cup {Marker(s, n, d) : s \in Threads, n \in 1..MaxLog, d \in Destinations}
TypeOK ==
  /\ logs \in [Threads -> Seq(Events)]
  /\ Originals \subseteq created /\ created \subseteq Threads
  /\ online \subseteq created
  /\ images \in [Destinations -> Seq(Events)]
  /\ requests \in [Destinations -> {<<>>} \cup (Threads \X (1..MaxLog))]
  /\ pending \subseteq sends /\ sends \subseteq Threads \X Invocations
  /\ crashes \in 0..MaxCrashes

ReplyIsolation == \A message \in sends : message[1] = ChildOf(message[2])
WaitIsolation == \A t \in created \cap Destinations : Waits(logs[t]) = {}
OriginalObligations ==
  /\ \A t \in Originals : ~\E i \in Invocations : Has(logs[t], DetachWait(i)) \/ Has(logs[t], DetachReply(i))
  /\ \A t \in Originals, i \in Invocations : Has(logs[t], Result(i)) =>
       /\ t = ParentOf[i]
       /\ <<ChildOf(i), i>> \in sends
ObligationOwnership == ReplyIsolation /\ WaitIsolation /\ OriginalObligations

(* RelationshipState distinguishes a received result from detachment and discharges every completed or detached edge. *)
RelationshipState ==
  /\ \A t \in created, i \in Invocations :
       /\ ~(Has(logs[t], Result(i)) /\ Has(logs[t], DetachWait(i)))
       /\ ~(Has(logs[t], Sent(i)) /\ Has(logs[t], DetachReply(i)))
       /\ Has(logs[t], DetachWait(i)) => Has(logs[t], Wait(i))
       /\ Has(logs[t], DetachReply(i)) => Has(logs[t], Accept(i))
  /\ \A t \in created \cap Destinations : Replies(logs[t]) = {}

(* AtomicPublication requires the complete checkpoint and detachments before the branch can run, including after recovery. *)
AtomicPublication == \A t \in created \cap Destinations :
  /\ Len(images[t]) > 0
  /\ IF Len(logs[t]) < Len(images[t]) THEN FALSE ELSE SubSeq(logs[t], 1, Len(images[t])) = images[t]
  /\ Cardinality({n \in DOMAIN logs[t] : logs[t][n] = Marker(requests[t][1], requests[t][2], t)}) = 1

(* WorkSettled reports completed computation independently of reply delivery (Finish, Send). *)
WorkSettled(t) == Has(logs[t], Done)

(* InteractionsSettled reports no remaining local waits or reply obligations; sent messages may still be in flight (Send, Deliver). *)
InteractionsSettled(t) == Waits(logs[t]) = {} /\ Replies(logs[t]) = {}

(* Resting requires both computation and interactions to be settled. *)
Resting(t) == WorkSettled(t) /\ InteractionsSettled(t)

(* NoMixedFork is a reachability probe: its counterexample must contain a fork with both incoming and outgoing detachments (ForkTreeMixedReachable.cfg). *)
NoMixedFork == ~\E t \in created \cap Destinations :
  /\ \E i \in Invocations : Has(logs[t], DetachReply(i))
  /\ \E i \in Invocations : Has(logs[t], DetachWait(i))

Settles == \A t \in Threads : (t \in created) ~> Resting(t)
OriginalRepliesArrive == \A i \in Invocations : <>Has(logs[ParentOf[i]], Result(i))
=============================================================================
