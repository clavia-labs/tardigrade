-------------------------- MODULE InvocationEpoch --------------------------
(* InvocationEpoch models one active execution owner for each logical method call. *)

EXTENDS FiniteSets, Naturals, TLC

CONSTANT Epochs

ModelEpochs == 0..2

ASSUME Epochs = ModelEpochs

VARIABLES current, status

vars == <<current, status>>

Init ==
  /\ current = 0
  /\ status = [epoch \in Epochs |-> IF epoch = 0 THEN "running" ELSE "absent"]

Finish ==
  /\ status[current] = "running"
  /\ status' = [status EXCEPT ![current] = "terminal"]
  /\ UNCHANGED current

Resume ==
  /\ status[current] = "terminal"
  /\ current + 1 \in Epochs
  /\ current' = current + 1
  /\ status' = [status EXCEPT ![current + 1] = "running"]

Next == Finish \/ Resume
Spec == Init /\ [][Next]_vars

(* ResumeWhileRunning models a new epoch taking ownership before the current epoch terminates. *)
ResumeWhileRunning ==
  /\ status[current] = "running"
  /\ current + 1 \in Epochs
  /\ current' = current + 1
  /\ status' = [status EXCEPT ![current + 1] = "running"]

NextOverlapping == Finish \/ Resume \/ ResumeWhileRunning
SpecOverlapping == Init /\ [][NextOverlapping]_vars

-----------------------------------------------------------------------------
TypeOK ==
  /\ current \in Epochs
  /\ status \in [Epochs -> {"absent", "running", "terminal"}]

AtMostOneActive == Cardinality({epoch \in Epochs : status[epoch] = "running"}) <= 1

CurrentOwnsActive ==
  \A epoch \in Epochs : status[epoch] = "running" => epoch = current

=============================================================================
