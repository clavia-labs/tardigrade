------------------------- MODULE AlarmScheduler -------------------------
(* AlarmScheduler models committed admissions racing with alarm completion.
   Execution covers the version captured at its start. Later admissions retain
   their wake until a subsequent pass. Waiter resolution and rejection are
   tested in alarm-scheduler.test.ts. Storage commit and crash coverage are
   modeled separately in DurableExecution. *)
EXTENDS Naturals

CONSTANTS MaxAdmissions, PreserveLaterWake
VARIABLES admitted, completed, snapshot, running, wake
vars == <<admitted, completed, snapshot, running, wake>>

Init == /\ admitted = 0 /\ completed = 0 /\ snapshot = 0
        /\ running = FALSE /\ wake = FALSE

Admit == /\ admitted < MaxAdmissions
         /\ admitted' = admitted + 1
         /\ wake' = TRUE
         /\ UNCHANGED <<completed, snapshot, running>>

Fire == /\ wake /\ ~running
        /\ running' = TRUE /\ snapshot' = admitted
        /\ UNCHANGED <<admitted, completed, wake>>

Complete == /\ running
            /\ completed' = snapshot
            /\ running' = FALSE
            /\ wake' = IF PreserveLaterWake THEN admitted > snapshot ELSE FALSE
            /\ UNCHANGED <<admitted, snapshot>>

Next == Admit \/ Fire \/ Complete
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Fire) /\ WF_vars(Complete)

TypeOK == /\ admitted \in 0..MaxAdmissions
          /\ completed \in 0..admitted
          /\ snapshot \in 0..admitted
          /\ running \in BOOLEAN /\ wake \in BOOLEAN
OwedHasWake == admitted > completed => wake
EventuallyCovered == admitted = MaxAdmissions ~> completed = MaxAdmissions
=============================================================================
