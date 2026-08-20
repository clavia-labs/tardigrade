------------------------------ MODULE Guard ------------------------------
(* The serve give-up guard's one premise: a counted attempt is an ENDED
   attempt. The guard reads "no progress across an attempt" as evidence
   that a body cannot progress. The reading is sound only when no attempt
   is in flight at the moment the guard counts or gives up; the
   single-writer chain is what makes it so (withActor and the awaited
   wake path, src/platform/host.ts; the decisions, src/platform/giveup.ts).

   The implementation counts in the log itself: Count is the append of a
   RecoveryAttempted mark before a re-drive, and GiveUp is the CodeSettled
   error verdict. The marks belong to the bookkeeping class, which the
   progress measure excludes, so this module's `len` and Append model the
   NON-bookkeeping appends only: a mark is a Count step here, never an
   Append. The theorem is storage-agnostic on purpose; it held for a meta
   counter and holds for the marks, because the race lives in timing, not
   in the store.

   This module makes the premise a theorem. One lane, one body, one
   guard. The body starts an attempt, appends progress (a replay that
   passes its recorded prefix appends a new call), and ends by returning
   a result or by dying. The guard counts stagnation and gives up at the
   limit. Two composition modes:

   Serial (the contract): the guard acts only between attempts. This is
     the implementation's shape: the wake awaits the attempt to its end,
     so the guard never observes a live body.
   Racy (the defect): the guard acts whenever, a watchdog reading state
     mid-attempt. A slow body's silence is indistinguishable from death,
     the verdict lands while the body runs, and the body's later result
     makes two terminal stories for one execution (the keyed store then
     absorbs the real result as a duplicate on cs:<execId>: the outcome
     the system shows is the verdict's lie, and with the marks in the
     log the mistake is also a permanent record).

   NODOUBLEOUTCOME is the debt: a verdict and a result never both stand.
   GuardRace.cfg expects TLC to refute it under Racy; Guard.cfg proves
   it under Serial. *)

EXTENDS Naturals

CONSTANTS Limit, MaxLen

ASSUME Limit \in Nat /\ Limit > 0
ASSUME MaxLen \in Nat /\ MaxLen > 0

VARIABLES inflight, len, seenLen, tries, verdict, result

vars == <<inflight, len, seenLen, tries, verdict, result>>

TypeOK ==
  /\ inflight \in BOOLEAN
  /\ len \in 0..MaxLen
  /\ seenLen \in 0..MaxLen
  /\ tries \in 0..(Limit + 1)
  /\ verdict \in BOOLEAN
  /\ result \in BOOLEAN

Init ==
  /\ inflight = FALSE
  /\ len = 0
  /\ seenLen = 0
  /\ tries = 0
  /\ verdict = FALSE
  /\ result = FALSE

(* The body's side. Start opens an attempt while the execution is
   unsettled. Append is progress: a replayed body that passes its
   recorded prefix makes a call it never made, and the call is an
   append. Return is the real settle: it ends the attempt and appends
   the terminal. Die ends the attempt with nothing. *)
Start ==
  /\ ~inflight
  /\ ~verdict
  /\ ~result
  /\ inflight' = TRUE
  /\ UNCHANGED <<len, seenLen, tries, verdict, result>>

Append ==
  /\ inflight
  /\ len < MaxLen
  /\ len' = len + 1
  /\ UNCHANGED <<inflight, seenLen, tries, verdict, result>>

Return ==
  /\ inflight
  /\ len < MaxLen
  /\ inflight' = FALSE
  /\ result' = TRUE
  /\ len' = len + 1
  /\ UNCHANGED <<seenLen, tries, verdict>>

Die ==
  /\ inflight
  /\ inflight' = FALSE
  /\ UNCHANGED <<len, seenLen, tries, verdict, result>>

(* The guard's side, parameterized by the gate. Count reads the log
   length: growth restarts the count, stagnation raises it. GiveUp is
   the verdict at the limit. The gate is the whole dispute: Serial
   demands ~inflight (the guard speaks between attempts), Racy demands
   nothing. *)
Count(gate) ==
  /\ gate
  /\ ~verdict
  /\ ~result
  /\ tries <= Limit
  /\ IF len > seenLen
       THEN /\ seenLen' = len
            /\ tries' = 1
       ELSE /\ tries' = tries + 1
            /\ seenLen' = len
  /\ UNCHANGED <<inflight, len, verdict, result>>

GiveUp(gate) ==
  /\ gate
  /\ ~verdict
  /\ ~result
  /\ tries > Limit
  /\ verdict' = TRUE
  /\ UNCHANGED <<inflight, len, seenLen, tries, result>>

NextSerial ==
  \/ Start \/ Append \/ Return \/ Die
  \/ Count(~inflight) \/ GiveUp(~inflight)

NextRacy ==
  \/ Start \/ Append \/ Return \/ Die
  \/ Count(TRUE) \/ GiveUp(TRUE)

SpecSerial == Init /\ [][NextSerial]_vars
SpecRacy   == Init /\ [][NextRacy]_vars

---------------------------------------------------------------------------
(* The debt. A verdict and a result never both stand: one execution gets
   one terminal story. Under Racy the guard condemns a live body and the
   body later returns; under Serial a verdict implies every attempt
   ended empty, and the verdict settles the execution, so no attempt
   starts again. *)
NoDoubleOutcome == ~(verdict /\ result)

===========================================================================
