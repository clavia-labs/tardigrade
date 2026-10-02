----------------------------- MODULE Replay -----------------------------
(* The replay matcher: the code thread's obligation when a body lies.

   A body re-runs from the top on every attempt, and the executor
   answers its nth question from the nth recorded call. That is sound
   exactly when the body is deterministic: same recorded answers, same
   next question. Determinism is a property of user code; no spec can
   prove it, no platform can assume it. This module models the body
   ADVERSARIALLY (any attempt may ask any question at any position) and
   itemizes what the matcher owes:

   RIGHTANSWER: an answer handed to the body was recorded for the
     question the body just asked. Never the recorded answer to a
     different question wearing the same position.

   The two matchers:

   Trusting (the defect): match by position alone. A drifted body's
     question receives the previous attempt's recorded answer for that
     position. RightAnswer fails in a handful of states; the trace is
     the misattribution (run-05c47383-668, 2026-08-16: a re-driven
     profiler re-dispatched its writer at a shifted position; the
     benign direction of the same defect).

   Guarded (the contract): match by position AND question. A mismatch
     refuses the execution loudly. RightAnswer holds, and refusal is
     the only outcome drift can reach: loud, never wrong. *)

EXTENDS Naturals, Sequences, TLC

CONSTANTS Questions, MaxCalls, Guarded

VARIABLES recorded, pos, refused, mismatched

vars == <<recorded, pos, refused, mismatched>>

TypeOK ==
  /\ recorded \in Seq([q: Questions, done: BOOLEAN])
  /\ Len(recorded) <= MaxCalls
  /\ pos \in 0..MaxCalls
  /\ refused \in BOOLEAN
  /\ mismatched \in BOOLEAN

Init ==
  /\ recorded = <<>>
  /\ pos = 0
  /\ refused = FALSE
  /\ mismatched = FALSE

(* The body asks its next question. Adversarial: q is ANY question,
   whatever earlier attempts asked at this position. *)
Ask(q) ==
  /\ ~refused
  /\ pos < MaxCalls
  /\ IF pos + 1 <= Len(recorded)
       THEN \* A recorded call sits at this position: the matcher decides.
            LET rec == recorded[pos + 1] IN
            IF rec.q = q
              THEN \* Faithful replay: advance, hand the recorded answer.
                   /\ pos' = pos + 1
                   /\ UNCHANGED <<recorded, refused, mismatched>>
              ELSE IF Guarded
                THEN \* The contract: a drifted question refuses loudly.
                     /\ refused' = TRUE
                     /\ UNCHANGED <<recorded, pos, mismatched>>
                ELSE \* The defect: the body receives the answer to rec.q
                     \* while having asked q. Nothing anywhere knows.
                     /\ mismatched' = TRUE
                     /\ pos' = pos + 1
                     /\ UNCHANGED <<recorded, refused>>
       ELSE \* Unrecorded: a fresh dispatch appends.
            /\ recorded' = Append(recorded, [q |-> q, done |-> FALSE])
            /\ pos' = pos + 1
            /\ UNCHANGED <<refused, mismatched>>

(* A dispatched call's answer lands. *)
Answer(i) ==
  /\ i \in 1..Len(recorded)
  /\ ~recorded[i].done
  /\ recorded' = [recorded EXCEPT ![i].done = TRUE]
  /\ UNCHANGED <<pos, refused, mismatched>>

(* A crash or park ends the attempt; the next re-runs from the top.
   The log survives; only the cursor resets. *)
Redrive ==
  /\ pos > 0
  /\ ~refused
  /\ pos' = 0
  /\ UNCHANGED <<recorded, refused, mismatched>>

Next ==
  \/ \E q \in Questions : Ask(q)
  \/ \E i \in 1..MaxCalls : Answer(i)
  \/ Redrive

Spec == Init /\ [][Next]_vars

(* The matcher's one obligation. Trusting fails it; Guarded holds it,
   and drift's only reachable outcome is the refusal. *)
RightAnswer == ~mismatched

=============================================================================
