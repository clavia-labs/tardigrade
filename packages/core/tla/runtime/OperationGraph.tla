--------------------------- MODULE OperationGraph ---------------------------
EXTENDS Naturals, FiniteSets

(* OperationGraph separates operation identity, data prerequisites, and invocation lifetime. The fixture has two downloads, a join, and independent audit work; logical operation names are independent of refs. Declaration stability is assumed from TransitionDeclarations.tla. This model trusts runtime-produced receipts and does not model arbitrary ingress metadata. *)
CONSTANTS CheckDependencies, MatchRef, CancelByDependencies, StableRefs,
          CheckCancellation, MaxCrashes, Fair
Ops == {"a", "b", "join", "audit"}
Needs(o) == IF o = "join" THEN {"a", "b"} ELSE {}
OwnerSeq(o) == IF o = "audit" THEN 2 ELSE 1
Component(o) == IF o = "b" THEN "right" ELSE "left"
Tag(o) == IF o = "join" THEN "combine" ELSE "fetch"
Invocation(epoch) == [method |-> "run", id |-> "same", epoch |-> epoch]
Invocations == {Invocation(0), Invocation(1)}
Owner(o) == Invocation(IF o \in {"a", "join"} THEN 0 ELSE 1)
ExpectedRef(o) == <<OwnerSeq(o), Component(o), Tag(o)>>
Phases == {"pending", "running", "returned", "checked"}
Refs == (1..(3 + Cardinality(Ops))) \X {"left", "right"} \X {"fetch", "combine"}

VARIABLES refs, phase, receipts, resolved, cancelled, crashes,
          prematureStart, cancelledStart, observedCancellation, cancelledPublication
vars == <<refs, phase, receipts, resolved, cancelled, crashes,
          prematureStart, cancelledStart, observedCancellation, cancelledPublication>>

Completed == {r.operation : r \in receipts}
OwnerCancelled(o) == Owner(o) \in cancelled
Suppressed(o) == OwnerCancelled(o) \/
  (CancelByDependencies /\ \E p \in Needs(o) : OwnerCancelled(p))
DependenciesReady(o) == IF CheckDependencies THEN Needs(o) \subseteq resolved
  ELSE Needs(o) = {} \/ Needs(o) \cap resolved # {}
Matches(o, receipt) == IF MatchRef THEN refs[o] = receipt.ref ELSE TRUE
Resolve(rs) == {o \in Ops : \E r \in rs : Matches(o, r)}
Ready(o) == o \notin resolved /\ ~Suppressed(o) /\ DependenciesReady(o)

Init ==
  /\ refs = [o \in Ops |-> ExpectedRef(o)]
  /\ phase = [o \in Ops |-> "pending"]
  /\ receipts = {} /\ resolved = {} /\ cancelled = {} /\ crashes = 0
  /\ prematureStart = FALSE /\ cancelledStart = FALSE /\ cancelledPublication = FALSE
  /\ observedCancellation = [o \in Ops |-> FALSE]

Start(o) ==
  /\ phase[o] = "pending" /\ Ready(o)
  /\ phase' = [phase EXCEPT ![o] = "running"]
  /\ prematureStart' = (prematureStart \/ ~(Needs(o) \subseteq Completed))
  /\ cancelledStart' = (cancelledStart \/ OwnerCancelled(o))
  /\ UNCHANGED <<refs, receipts, resolved, cancelled, crashes, observedCancellation, cancelledPublication>>

(* Return abstracts an external attempt that returns; an external side effect before durable completion may repeat after Crash. *)
Return(o) ==
  /\ phase[o] = "running"
  /\ phase' = [phase EXCEPT ![o] = "returned"]
  /\ UNCHANGED <<refs, receipts, resolved, cancelled, crashes, prematureStart,
                   cancelledStart, observedCancellation, cancelledPublication>>

(* CheckResult observes cancellation before append; Cancel may still occur between this action and Commit. *)
CheckResult(o) ==
  /\ phase[o] = "returned"
  /\ observedCancellation' = [observedCancellation EXCEPT ![o] = OwnerCancelled(o)]
  /\ phase' = [phase EXCEPT ![o] = IF CheckCancellation /\ Suppressed(o) THEN "pending" ELSE "checked"]
  /\ UNCHANGED <<refs, receipts, resolved, cancelled, crashes, prematureStart, cancelledStart, cancelledPublication>>

Commit(o) ==
  /\ phase[o] = "checked"
  /\ receipts' = receipts \cup {[operation |-> o, ref |-> refs[o]]}
  /\ resolved' = Resolve(receipts')
  /\ phase' = [phase EXCEPT ![o] = "pending"]
  /\ cancelledPublication' = (cancelledPublication \/ observedCancellation[o])
  /\ UNCHANGED <<refs, cancelled, crashes, prematureStart, cancelledStart, observedCancellation>>

Cancel(invocation) ==
  /\ invocation \notin cancelled
  /\ cancelled' = cancelled \cup {invocation}
  /\ UNCHANGED <<refs, phase, receipts, resolved, crashes, prematureStart,
                   cancelledStart, observedCancellation, cancelledPublication>>

(* Crash discards an uncommitted attempt while retaining its declaration and receipts. A crash after commit is represented by Replay. *)
Crash(o) ==
  /\ phase[o] # "pending" /\ crashes < MaxCrashes
  /\ crashes' = crashes + 1
  /\ phase' = [phase EXCEPT ![o] = "pending"]
  /\ UNCHANGED <<refs, receipts, resolved, cancelled, prematureStart,
                   cancelledStart, observedCancellation, cancelledPublication>>

Replay ==
  /\ resolved' = Resolve(receipts)
  /\ UNCHANGED <<refs, phase, receipts, cancelled, crashes, prematureStart,
                   cancelledStart, observedCancellation, cancelledPublication>>

(* Reoffer exposes a defect that makes an operation's identity follow prerequisite progress. The correct declaration remains anchored to its original owner. *)
Reoffer(o) ==
  /\ phase[o] = "pending" /\ Needs(o) \cap resolved # {}
  /\ refs' = [refs EXCEPT ![o] = IF StableRefs THEN @
       ELSE <<3 + Cardinality(Completed), Component(o), Tag(o)>>]
  /\ UNCHANGED <<phase, receipts, resolved, cancelled, crashes, prematureStart,
                   cancelledStart, observedCancellation, cancelledPublication>>

Next == Replay \/ (\E i \in Invocations : Cancel(i)) \/
  (\E o \in Ops : Start(o) \/ Return(o) \/ CheckResult(o) \/ Commit(o) \/ Crash(o) \/ Reoffer(o))
Progress == \A o \in Ops : WF_vars(Start(o)) /\ WF_vars(Return(o))
  /\ WF_vars(CheckResult(o)) /\ WF_vars(Commit(o))
Spec == Init /\ [][Next]_vars /\ (IF Fair THEN Progress ELSE TRUE)

TypeOK ==
  /\ refs \in [Ops -> Refs] /\ phase \in [Ops -> Phases]
  /\ receipts \subseteq [operation : Ops, ref : Refs] /\ resolved \subseteq Ops
  /\ cancelled \subseteq Invocations /\ crashes \in 0..MaxCrashes
  /\ observedCancellation \in [Ops -> BOOLEAN]
  /\ prematureStart \in BOOLEAN /\ cancelledStart \in BOOLEAN /\ cancelledPublication \in BOOLEAN
IdentityStable == \A o \in Ops : refs[o] = ExpectedRef(o)
ExactResolution == resolved = Completed
CancellationIsolation == \A o \in Ops : Suppressed(o) = OwnerCancelled(o)
NoPrematureStart == ~prematureStart
NoCancelledStart == ~cancelledStart
NoObservedCancelledPublication == ~cancelledPublication
ReadySettles == \A o \in Ops : Ready(o) ~> (o \in Completed \/ OwnerCancelled(o))

(* Safety follows by induction when all checks are enabled and CancelByDependencies is FALSE. ExpectedRef is injective on the fixture, so Resolve adds exactly the receipt's operation. Start checks actual completed prerequisites through ExactResolution. Cancel changes only invocation lifetime. CheckResult prevents publication when cancellation was observed there. Replay preserves resolution and Reoffer preserves refs. This is a written argument over the model, not a mechanically checked refinement proof of TypeScript. *)

(* ReadySettles follows under Progress and bounded crashes. Once ready, prerequisites remain completed. Cancellation either settles the obligation's lifetime or it stays eligible. After the final crash, weak fairness advances pending, running, returned, and checked phases to commit. A join with a cancelled, uncompleted prerequisite can remain blocked; it is not thereby cancelled. Effect termination and available storage are fairness assumptions here, not scheduler guarantees inferred from identity. *)
=============================================================================
