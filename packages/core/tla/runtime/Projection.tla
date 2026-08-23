--------------------------- MODULE Projection ---------------------------
(* The doctrine module: state is a projection of the log, and a projection
   must be FAITHFUL. Faithful means: the room the system stood in when it
   acted at position i is re-derivable, unchanged, from every future log.
   Appends may extend the story; they may never rewrite it.

   The module carries one miniature machine (three rooms, six event kinds,
   the shape of src/code/execute.ts's code machine) and folds it under two
   membership semantics:

   PREFIX semantics: an event's relevance is judged from its own prefix,
   at its own position, once. This is the projection-only design: guards.

   VIEW semantics: a reply's membership is judged from the WHOLE log at
   fold time: it is visible only while its call is still open, and the
   harvest closes the call. This is parkAwareView's invitation rule
   (src/code/execute.ts:78-93), the shape that wedged agent .5 of run
   run-fcb28550-3be on 2026-08-15: the org's alarm was deleted while a
   dispatched execution sat unrunnable behind a fold trapped in "parked".

   THE TWO THEOREMS. PrefixFaithful holds over every history: prefix folds
   are interpretation-monotonic by construction. ViewFaithful is CHECKED
   AND EXPECTED TO FAIL (ProjectionView.cfg): TLC's counterexample is the
   production wedge, six events long. The failing trace is the bug report.

   House rules: no RECURSIVE (the fold is a CHOOSE over bounded function
   space, evaluated only in invariants); every quantifier ranges over
   written positions. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC, Log

CONSTANT MaxLen

Events == {"dispatch", "start", "park", "reply", "harvest", "settle"}
Rooms  == {"idle", "executing", "parked"}

(* The rulebook. A pair with no rule stays put: the skip. *)
Step(room, e) ==
  CASE room = "idle"      /\ e = "dispatch" -> "executing"
    [] room = "executing" /\ e = "settle"   -> "idle"
    [] room = "executing" /\ e = "park"     -> "parked"
    [] room = "parked"    /\ e = "reply"    -> "executing"
    [] OTHER                                -> room

-----------------------------------------------------------------------
(* Membership: is the event at position i on the walker's path?
   Everything but a reply always is. A reply rides its call. *)

(* PREFIX: the call is open as judged at the reply's own position: a park
   before it, no harvest before it. Later appends are not consulted, so
   this verdict can never change. *)
PrefixVisible(log, i) ==
  \/ log[i] # "reply"
  \/ /\ \E j \in 1..(i - 1): log[j] = "park"
     /\ ~\E k \in 1..(i - 1): log[k] = "harvest"

(* VIEW: the call is open as judged from the whole log at fold time. The
   harvest, wherever it lands, revokes the reply's membership backward. *)
ViewVisible(log, i) ==
  \/ log[i] # "reply"
  \/ /\ \E j \in 1..(i - 1): log[j] = "park"
     /\ ~\E k \in DOMAIN log: log[k] = "harvest"

-----------------------------------------------------------------------
(* The fold, as a chosen trace: the unique room sequence consistent with
   the rulebook under the given membership. Direct definition, no
   recursion; the function space is 3^(i+1), bounded by MaxLen. *)

PrefixFoldAt(log, i) ==
  CHOOSE f \in [0..i -> Rooms]:
    /\ f[0] = "idle"
    /\ \A k \in 1..i:
         f[k] = IF PrefixVisible(log, k) THEN Step(f[k - 1], log[k]) ELSE f[k - 1]

ViewFoldAt(log, i) ==
  CHOOSE f \in [0..i -> Rooms]:
    /\ f[0] = "idle"
    /\ \A k \in 1..i:
         f[k] = IF ViewVisible(log, k) THEN Step(f[k - 1], log[k]) ELSE f[k - 1]

PrefixRoom(log, i) == PrefixFoldAt(log, i)[i]
ViewRoom(log, i)   == ViewFoldAt(log, i)[i]

-----------------------------------------------------------------------
(* The behavior: the log grows one event at a time; at each append both
   walkers record the room they believe in AT THAT MOMENT. The traces are
   the system's actual conduct: what settle consulted, what resting()
   answered, what the alarm trusted. *)

VARIABLES log, ptrace, vtrace

vars == <<log, ptrace, vtrace>>

Init ==
  /\ log = <<>>
  /\ ptrace = <<>>
  /\ vtrace = <<>>

Append1(e) ==
  /\ Len(log) < MaxLen
  /\ log' = Append(log, e)
  /\ ptrace' = Append(ptrace, PrefixRoom(log', Len(log')))
  /\ vtrace' = Append(vtrace, ViewRoom(log', Len(log')))

Next == \E e \in Events: Append1(e)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------
(* Faithfulness: what was believed at position i is re-derivable at
   position i from today's log. The recorded trace and the recomputation
   must agree, forever. *)

PrefixFaithful ==
  \A i \in DOMAIN ptrace: ptrace[i] = PrefixRoom(log, i)

ViewFaithful ==
  \A i \in DOMAIN vtrace: vtrace[i] = ViewRoom(log, i)

=======================================================================
