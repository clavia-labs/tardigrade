------------------------- MODULE TransitionOwnership -------------------------
EXTENDS Naturals, Sequences, FiniteSets

(* TransitionOwnership checks invocation inheritance across an intent/effect event chain (DeclarationOwner, EventOwner, ScopeCorrect, CancellationObserved). TransitionDeclarations.tla establishes reference uniqueness separately. Expected ownership is tracked independently from carried metadata. *)
CONSTANTS None, Detach, MaxEvents, CarryDeclaration, CarryCompletion, RejectOverride,
          BindScope, KeepScopeDetails, MatchMode, CheckStart, SignalActive,
          CheckResult, Fair

Invocation(method, id, epoch) == [method |-> method, id |-> id, epoch |-> epoch]
Base == Invocation("run", "one", 0)
Invocations == {Base, Invocation("run", "one", 1),
               Invocation("other", "one", 0), Invocation("run", "two", 0)}
Owners == Invocations \cup {None}
Kinds == {"intent", "effect"}
Context(owner) == IF owner = None THEN None ELSE
  [invocation |-> owner, parent |-> Invocation("parent", owner.id, owner.epoch),
   deadlineAt |-> 10 + owner.epoch]
BareContext(owner) == IF owner = None THEN None ELSE
  [invocation |-> owner, parent |-> None, deadlineAt |-> None]

VARIABLES events, nextSeq, transition, phase, cancelled, signalled, scopes,
          checkedCancellation, badStart, badPublication
vars == <<events, nextSeq, transition, phase, cancelled, signalled, scopes,
          checkedCancellation, badStart, badPublication>>

Same(a, b) == CASE MatchMode = "exact" -> a = b
               [] MatchMode = "noEpoch" -> a.method = b.method /\ a.id = b.id
               [] MatchMode = "noMethod" -> a.id = b.id /\ a.epoch = b.epoch
               [] MatchMode = "noId" -> a.method = b.method /\ a.epoch = b.epoch
IsCancelled(owner) == IF owner = None THEN FALSE ELSE \E c \in cancelled : Same(owner, c)
Inherited(event, explicit) == IF explicit = Detach THEN None ELSE IF explicit = None THEN event.owner ELSE explicit
Carried(event, explicit) == IF CarryDeclaration THEN Inherited(event, explicit) ELSE None
Last == events[Len(events)]

Init ==
  /\ \E owner \in Owners : events = <<[seq |-> 1, expected |-> owner, owner |-> owner]>>
  /\ nextSeq = 2
  /\ transition = None
  /\ phase = "idle"
  /\ cancelled = {}
  /\ signalled = FALSE
  /\ scopes = {}
  /\ checkedCancellation = FALSE
  /\ badStart = FALSE
  /\ badPublication = FALSE

(* Declare models bindTransitionContext and both tagged constructors. An unowned event may acquire explicit ownership; an owned event rejects a different explicit invocation, including a different epoch. Detach explicitly removes invocation ownership for control delivery after cancellation, while preserving transition identity. *)
Declare(kind, explicit) ==
  /\ phase = "idle" /\ Len(events) < MaxEvents
  /\ RejectOverride => (Last.owner = None \/ explicit = None \/ explicit = Detach \/ explicit = Last.owner)
  /\ transition' = [source |-> Len(events), ref |-> <<Last.seq, "worker", "step">>,
       kind |-> kind, explicit |-> explicit,
       expected |-> IF explicit = Detach THEN None ELSE IF Last.expected = None THEN explicit ELSE Last.expected,
       owner |-> Carried(Last, explicit)]
  /\ phase' = "ready"
  /\ signalled' = FALSE
  /\ UNCHANGED <<events, nextSeq, cancelled, scopes, checkedCancellation, badStart, badPublication>>

(* Replay reconstructs a pending declaration from its durable owning event and the same explicit declaration. It preserves the reference and logical owner; this action does not model crashes of running attempts. *)
Replay ==
  /\ phase = "ready"
  /\ transition' = [transition EXCEPT !.owner = Carried(events[transition.source], transition.explicit)]
  /\ UNCHANGED <<events, nextSeq, phase, cancelled, signalled, scopes,
                  checkedCancellation, badStart, badPublication>>

Suppress ==
  /\ phase = "ready" /\ CheckStart /\ IsCancelled(transition.owner)
  /\ phase' = "finished"
  /\ UNCHANGED <<events, nextSeq, transition, cancelled, signalled, scopes,
                  checkedCancellation, badStart, badPublication>>

StartEffect ==
  /\ phase = "ready" /\ transition.kind = "effect"
  /\ ~CheckStart \/ ~IsCancelled(transition.owner)
  /\ phase' = "running"
  /\ scopes' = scopes \cup {[expected |-> Context(transition.expected),
       actual |-> IF ~BindScope THEN None ELSE
         IF KeepScopeDetails THEN Context(transition.owner) ELSE BareContext(transition.owner)]}
  /\ badStart' = (badStart \/ transition.expected \in cancelled)
  /\ UNCHANGED <<events, nextSeq, transition, cancelled, signalled, checkedCancellation, badPublication>>

(* Cancel represents a request observed by the mounted live interruption registry. The actor classifies this invocation as running; delivery to that registry is an assumption of this model. *)
Cancel(target) ==
  /\ target \notin cancelled
  /\ cancelled' = cancelled \cup {target}
  /\ nextSeq' = nextSeq + 1
  /\ signalled' = (signalled \/
       (IF phase = "running" /\ SignalActive THEN
          IF transition.owner = None THEN FALSE ELSE Same(transition.owner, target)
        ELSE FALSE))
  /\ UNCHANGED <<events, transition, phase, scopes, checkedCancellation, badStart, badPublication>>

(* CheckCompletion records what the runtime observes before appending the result. Cancellation may arrive between this check and CommitEffect. NoObservedCancelledResults concerns that observed prefix, so it makes no atomic check-and-append claim. *)
CheckCompletion ==
  /\ phase = "running"
  /\ checkedCancellation' = (transition.expected \in cancelled)
  /\ phase' = IF CheckResult /\ IsCancelled(transition.owner) THEN "finished" ELSE "checked"
  /\ UNCHANGED <<events, nextSeq, transition, cancelled, signalled, scopes, badStart, badPublication>>

AppendCompletion ==
  /\ events' = Append(events, [seq |-> nextSeq, expected |-> transition.expected,
                              owner |-> IF CarryCompletion THEN transition.owner ELSE None])
  /\ nextSeq' = nextSeq + 1
  /\ phase' = "idle"

CommitEffect ==
  /\ phase = "checked"
  /\ AppendCompletion
  /\ badPublication' = (badPublication \/ checkedCancellation)
  /\ UNCHANGED <<transition, cancelled, signalled, scopes, checkedCancellation, badStart>>

CommitIntent ==
  /\ phase = "ready" /\ transition.kind = "intent"
  /\ ~CheckStart \/ ~IsCancelled(transition.owner)
  /\ AppendCompletion
  /\ badStart' = (badStart \/ transition.expected \in cancelled)
  /\ UNCHANGED <<transition, cancelled, signalled, scopes, checkedCancellation, badPublication>>

Next ==
  \/ \E kind \in Kinds, explicit \in Owners \cup {Detach} : Declare(kind, explicit)
  \/ Replay \/ Suppress \/ StartEffect \/ CheckCompletion \/ CommitEffect \/ CommitIntent
  \/ \E target \in Invocations : Cancel(target)
Progress == WF_vars(Suppress) /\ WF_vars(StartEffect) /\ WF_vars(CheckCompletion)
            /\ WF_vars(CommitEffect) /\ WF_vars(CommitIntent)
Spec == Init /\ [][Next]_vars /\ (IF Fair THEN Progress ELSE TRUE)

TypeOK ==
  /\ events \in Seq([seq : 1..(MaxEvents + Cardinality(Invocations)), expected : Owners, owner : Owners])
  /\ Len(events) \in 1..MaxEvents
  /\ nextSeq = 1 + Len(events) + Cardinality(cancelled)
  /\ phase \in {"idle", "ready", "running", "checked", "finished"}
  /\ cancelled \subseteq Invocations
  /\ signalled \in BOOLEAN /\ checkedCancellation \in BOOLEAN
  /\ badStart \in BOOLEAN /\ badPublication \in BOOLEAN
  /\ transition = None \/
       (transition.source \in 1..Len(events) /\ transition.kind \in Kinds
        /\ transition.owner \in Owners /\ transition.expected \in Owners /\ transition.explicit \in Owners \cup {Detach})

ReferenceStable == IF transition = None THEN TRUE ELSE
  transition.ref = <<events[transition.source].seq, "worker", "step">>
DeclarationOwner == IF transition = None THEN TRUE ELSE transition.owner = transition.expected
EventOwner == \A i \in 1..Len(events) : events[i].owner = events[i].expected
ScopeCorrect == \A s \in scopes : s.actual = s.expected
CancellationIsolation == IF phase \in {"ready", "running"}
  THEN IsCancelled(transition.owner) = (transition.expected \in cancelled) ELSE TRUE
CancellationObserved == IF phase = "running" THEN (transition.expected \in cancelled => signalled) ELSE TRUE
NoCancelledStart == ~badStart
NoObservedCancelledResults == ~badPublication
PendingSettles == phase \in {"ready", "running", "checked"} ~> phase \in {"idle", "finished"}

(* DeclarationOwner and EventOwner hold by mutual induction when metadata is preserved and conflicting overrides are rejected. Init agrees on root ownership. Declare preserves an owned event's expected owner, supplies the explicit owner of an unowned event, or explicitly detaches control delivery to None. AppendCompletion copies that expected owner to the next event. Replay reconstructs the same declaration. Every other action preserves both owners. This argument includes None and treats intent and effect declarations identically. *)

(* ScopeCorrect follows because StartEffect binds the full accepted Context of the carried owner and DeclarationOwner equates that owner to the expected owner. CancellationIsolation follows from exact equality on method, id, and epoch. CheckStart blocks already cancelled owners; Cancel signals an active effect of exactly its target invocation. CheckCompletion suppresses results when the observed prefix includes cancellation. These arguments depend on the corresponding switches being enabled and do not establish cancellation/append atomicity or exactly-once execution. *)

(* PendingSettles follows under Progress: a ready cancelled transition can be suppressed, a ready intent can commit, and a ready effect can start; a running effect can check its result, and a checked effect can commit. Cancellation is monotone and finite, so the applicable action eventually stays enabled. Weak fairness takes each action in this finite path. This assumes the action returns or responds to interruption, scope lookup succeeds, and appending remains available. The written arguments are not mechanically checked proofs; TLC exhaustively checks the configured finite instances. *)

=============================================================================
