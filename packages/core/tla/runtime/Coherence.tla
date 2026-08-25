---------------------------- MODULE Coherence ----------------------------
(* Coherence models transitions derived from one event-set snapshot. A withdrawal may suppress a start, a permission refusal may suppress protected work, and a terminal verdict may suppress a retry. *)

(* Suppresses is directional. <<a, b>> means that the complete derivation chooses a over b. ExampleActions includes unrelated work that resolution must retain. *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Actions, Suppresses

ExampleActions == {"start", "withdraw", "observe"}
ExampleSuppresses == {<<"withdraw", "start">>}

ASSUME Suppresses \subseteq (Actions \X Actions)
ASSUME \A action \in Actions: <<action, action>> \notin Suppresses

VARIABLES committed, pending, derived

vars == <<committed, pending, derived>>

TypeOK ==
  /\ committed \subseteq Actions
  /\ pending \subseteq Actions
  /\ derived \in BOOLEAN

Init ==
  /\ committed = {}
  /\ pending = {}
  /\ derived = FALSE

(* DeriveBatch captures every transition from one snapshot. FirePending consumes that set without consulting commits made earlier in the pass. *)
DeriveBatch ==
  /\ ~derived
  /\ pending' = Actions
  /\ derived' = TRUE
  /\ UNCHANGED committed

FirePending(action) ==
  /\ action \in pending
  /\ committed' = committed \cup {action}
  /\ pending' = pending \ {action}
  /\ UNCHANGED derived

NextBatch ==
  \/ DeriveBatch
  \/ \E action \in Actions: FirePending(action)

SpecBatch == Init /\ [][NextBatch]_vars

(* Enabled revalidates after each commit. It still permits suppressed work to commit before its suppressor. *)
Enabled(action) ==
  /\ action \notin committed
  /\ ~\E suppressor \in committed: <<suppressor, action>> \in Suppresses

FireEnabled(action) ==
  /\ Enabled(action)
  /\ committed' = committed \cup {action}
  /\ UNCHANGED <<pending, derived>>

NextRevalidated == \E action \in Actions: FireEnabled(action)

SpecRevalidated == Init /\ [][NextRevalidated]_vars

(* Resolved removes suppressed transitions from the complete set before an external effect begins. Compatible transitions may commit in any order. *)
Resolved == {action \in Actions: ~\E suppressor \in Actions: <<suppressor, action>> \in Suppresses}

FireResolved(action) ==
  /\ action \in Resolved \ committed
  /\ committed' = committed \cup {action}
  /\ UNCHANGED <<pending, derived>>

NextResolved == \E action \in Resolved: FireResolved(action)

SpecResolved ==
  /\ Init
  /\ [][NextResolved]_vars
  /\ \A action \in Resolved: WF_vars(FireResolved(action))

---------------------------------------------------------------------------
(* NoSuppressedCommit prevents a suppressor and its suppressed transition from committing together. *)
NoSuppressedCommit ==
  \A suppressor \in committed:
    \A suppressed \in committed:
      <<suppressor, suppressed>> \notin Suppresses

(* ResolvedSettles requires every surviving transition to commit. *)
ResolvedSettles == <>(committed = Resolved)

===========================================================================
