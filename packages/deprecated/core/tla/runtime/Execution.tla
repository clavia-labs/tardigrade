---------------------------- MODULE Execution ----------------------------
(* Execution models the completion barrier for one code attempt.

   Package calls run together. A ready call returns a value. A parked call records the reply it awaits and leaves the code body pending. Once every call has completed host-side, any parked call must release the body fiber so the durable attempt can close.

   ReadySilent is the observed defect. It omits the gate check when a ready call completes, so a parked call followed by the final ready call retains the fiber forever. *)

EXTENDS FiniteSets, TLC

CONSTANTS Calls, ParkedCalls

ASSUME Calls /= {}
ASSUME ParkedCalls \subseteq Calls
ASSUME ParkedCalls /= {}

VARIABLES remaining, parked, returned, gate

vars == <<remaining, parked, returned, gate>>

TypeOK ==
  /\ remaining \subseteq Calls
  /\ parked \subseteq ParkedCalls
  /\ returned \subseteq Calls \ ParkedCalls
  /\ gate \in BOOLEAN

Init ==
  /\ remaining = Calls
  /\ parked = {}
  /\ returned = {}
  /\ gate = FALSE

Park(c) ==
  /\ c \in remaining \cap ParkedCalls
  /\ remaining' = remaining \ {c}
  /\ parked' = parked \cup {c}
  /\ gate' = IF remaining' = {} THEN TRUE ELSE gate
  /\ UNCHANGED returned

Ready(c) ==
  /\ c \in remaining \ ParkedCalls
  /\ remaining' = remaining \ {c}
  /\ returned' = returned \cup {c}
  /\ gate' = IF parked /= {} /\ remaining' = {} THEN TRUE ELSE gate
  /\ UNCHANGED parked

(* ReadySilent reproduces the defect: only Park can signal the gate. *)
ReadySilent(c) ==
  /\ c \in remaining \ ParkedCalls
  /\ remaining' = remaining \ {c}
  /\ returned' = returned \cup {c}
  /\ UNCHANGED <<parked, gate>>

Complete(c) == IF c \in ParkedCalls THEN Park(c) ELSE Ready(c)
CompleteWithLeak(c) == IF c \in ParkedCalls THEN Park(c) ELSE ReadySilent(c)

Next == \E c \in Calls: Complete(c)
LeakNext == \E c \in Calls: CompleteWithLeak(c)

Spec == Init /\ [][Next]_vars /\ \A c \in Calls: WF_vars(Complete(c))
LeakSpec == Init /\ [][LeakNext]_vars

-------------------------------------------------------------------------

CompletionAccounting == remaining \cup parked \cup returned = Calls

CompletionExclusive ==
  /\ remaining \cap parked = {}
  /\ remaining \cap returned = {}
  /\ parked \cap returned = {}

GateSound == gate => parked /= {} /\ remaining = {}

ParkedAttemptReleases == parked /= {} /\ remaining = {} => gate

EventuallyReleased == <>gate

=============================================================================
