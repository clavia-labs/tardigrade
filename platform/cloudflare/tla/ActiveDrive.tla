---------------------------- MODULE ActiveDrive ----------------------------
(* ActiveDrive models successful ThreadDO.kick lifetimes and request retention (PR #387, 058e0e8). Admission abstracts durable acceptance followed by kick; drain and alarm synchronization are separate steps. Storage, failures, and request termination are outside this model. *)

EXTENDS Naturals, FiniteSets

CONSTANTS Requests, MaxDrives, RetainJoined, ContinueAtSync

ASSUME Requests /= {}
ASSUME MaxDrives \in Nat /\ MaxDrives >= Cardinality(Requests)
ASSUME RetainJoined \in BOOLEAN /\ ContinueAtSync \in BOOLEAN

VARIABLES admitted, done, slot, allocated, phase, owner, joined, retained

vars == <<admitted, done, slot, allocated, phase, owner, joined, retained>>
Drives == 1..MaxDrives
Owed == admitted \ done
Processing == {d \in Drives: phase[d] \in {"drain", "sync"}}

TypeOK ==
  /\ admitted \subseteq Requests
  /\ done \subseteq admitted
  /\ slot \in 0..MaxDrives
  /\ allocated \in 0..MaxDrives
  /\ phase \in [Drives -> {"unused", "drain", "sync", "completed", "cleaned"}]
  /\ owner \in [Drives -> SUBSET Requests]
  /\ joined \in [Requests -> 0..MaxDrives]
  /\ retained \subseteq Requests \X Drives

Init ==
  /\ admitted = {}
  /\ done = {}
  /\ slot = 0
  /\ allocated = 0
  /\ phase = [d \in Drives |-> "unused"]
  /\ owner = [d \in Drives |-> {}]
  /\ joined = [r \in Requests |-> 0]
  /\ retained = {}

(* Admit records which drive a request joins and which promise its scope retains (ThreadDO.kick, PR #387). *)
Admit(r) ==
  /\ r \notin admitted
  /\ slot /= 0 \/ allocated < MaxDrives
  /\ admitted' = admitted \cup {r}
  /\ IF slot = 0
     THEN LET d == allocated + 1 IN
       /\ allocated' = d
       /\ slot' = d
       /\ phase' = [phase EXCEPT ![d] = "drain"]
       /\ owner' = [owner EXCEPT ![d] = {r}]
       /\ joined' = [joined EXCEPT ![r] = d]
       /\ retained' = retained \cup {<<r, d>>}
     ELSE
       /\ joined' = [joined EXCEPT ![r] = slot]
       /\ retained' = IF RetainJoined THEN retained \cup {<<r, slot>>} ELSE retained
       /\ UNCHANGED <<allocated, slot, phase, owner>>
  /\ UNCHANGED done

Drain(d) ==
  /\ phase[d] = "drain"
  /\ done' = admitted
  /\ phase' = [phase EXCEPT ![d] = "sync"]
  /\ UNCHANGED <<admitted, slot, allocated, owner, joined, retained>>

(* Synchronize preserves the admission gap at await synchronizeAlarm and makes the final work check and release atomic when ContinueAtSync is enabled (drainUntilResting, PR #387). *)
Synchronize(d) ==
  /\ phase[d] = "sync"
  /\ IF ContinueAtSync /\ Owed /= {}
     THEN
       /\ phase' = [phase EXCEPT ![d] = "drain"]
       /\ UNCHANGED slot
     ELSE
       /\ phase' = [phase EXCEPT ![d] = "completed"]
       /\ slot' = IF ContinueAtSync THEN 0 ELSE slot
  /\ UNCHANGED <<admitted, done, allocated, owner, joined, retained>>

(* Cleanup represents the old finally continuation, whose successor inherits the starting request's scope (ThreadDO.kick, parent of 058e0e8). *)
Cleanup(d) ==
  /\ ~ContinueAtSync
  /\ phase[d] = "completed"
  /\ slot = d
  /\ Owed = {} \/ allocated < MaxDrives
  /\ IF Owed /= {}
     THEN LET successor == allocated + 1 IN
       /\ allocated' = successor
       /\ slot' = successor
       /\ phase' = [phase EXCEPT ![d] = "cleaned", ![successor] = "drain"]
       /\ owner' = [owner EXCEPT ![successor] = owner[d]]
       /\ retained' = retained \cup (owner[d] \X {successor})
     ELSE
       /\ slot' = 0
       /\ phase' = [phase EXCEPT ![d] = "cleaned"]
       /\ UNCHANGED <<allocated, owner, retained>>
  /\ UNCHANGED <<admitted, done, joined>>

Next == (\E r \in Requests: Admit(r)) \/
        (\E d \in Drives: Drain(d) \/ Synchronize(d) \/ Cleanup(d))

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ \A d \in Drives: WF_vars(Drain(d))
  /\ \A d \in Drives: WF_vars(Synchronize(d))
  /\ \A d \in Drives: WF_vars(Cleanup(d))

SingleProcessor == Cardinality(Processing) <= 1
ProcessingOwnsSlot == \A d \in Processing: slot = d
AdmissionRetained == \A r \in admitted: <<r, joined[r]>> \in retained
JoinedWorkDrained == \A r \in Owed: phase[joined[r]] \notin {"completed", "cleaned"}
EventuallyServed == \A r \in Requests: (r \in admitted) ~> (r \in done)

=============================================================================
