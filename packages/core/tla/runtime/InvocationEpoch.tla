-------------------------- MODULE InvocationEpoch --------------------------
(* InvocationEpoch models one active execution owner for each logical method call. *)

EXTENDS FiniteSets, Naturals, TLC

CONSTANT Epochs

ModelEpochs == 0..2

ASSUME Epochs = ModelEpochs

VARIABLES current, status, parent, deadline

vars == <<current, status, parent, deadline>>

Init ==
  /\ current = 0
  /\ status = [epoch \in Epochs |-> IF epoch = 0 THEN "running" ELSE "absent"]
  /\ parent = [epoch \in Epochs |-> IF epoch = 0 THEN "caller" ELSE "none"]
  /\ deadline = [epoch \in Epochs |-> IF epoch = 0 THEN 10 ELSE -1]

Finish ==
  /\ status[current] = "running"
  /\ status' = [status EXCEPT ![current] = "terminal"]
  /\ UNCHANGED <<current, parent, deadline>>

Resume ==
  /\ status[current] = "terminal"
  /\ current + 1 \in Epochs
  /\ current' = current + 1
  /\ status' = [status EXCEPT ![current + 1] = "running"]
  /\ parent' = [parent EXCEPT ![current + 1] = parent[current]]
  /\ deadline' = [deadline EXCEPT ![current + 1] = deadline[current]]

Next == Finish \/ Resume
Spec == Init /\ [][Next]_vars

(* ResumeWhileRunning models a new epoch taking ownership before the current epoch terminates. *)
ResumeWhileRunning ==
  /\ status[current] = "running"
  /\ current + 1 \in Epochs
  /\ current' = current + 1
  /\ status' = [status EXCEPT ![current + 1] = "running"]
  /\ parent' = [parent EXCEPT ![current + 1] = parent[current]]
  /\ deadline' = [deadline EXCEPT ![current + 1] = deadline[current]]

NextOverlapping == Finish \/ Resume \/ ResumeWhileRunning
SpecOverlapping == Init /\ [][NextOverlapping]_vars

(* ResumeDetached models a resumed epoch that silently loses its caller scope. *)
ResumeDetached ==
  /\ status[current] = "terminal"
  /\ current + 1 \in Epochs
  /\ current' = current + 1
  /\ status' = [status EXCEPT ![current + 1] = "running"]
  /\ parent' = [parent EXCEPT ![current + 1] = "none"]
  /\ deadline' = [deadline EXCEPT ![current + 1] = -1]

NextDetached == Finish \/ ResumeDetached
SpecDetached == Init /\ [][NextDetached]_vars

-----------------------------------------------------------------------------
TypeOK ==
  /\ current \in Epochs
  /\ status \in [Epochs -> {"absent", "running", "terminal"}]
  /\ parent \in [Epochs -> {"none", "caller"}]
  /\ deadline \in [Epochs -> {-1, 10}]

AtMostOneActive == Cardinality({epoch \in Epochs : status[epoch] = "running"}) <= 1

CurrentOwnsActive ==
  \A epoch \in Epochs : status[epoch] = "running" => epoch = current

ResumePreservesContext ==
  \A epoch \in Epochs : status[epoch] # "absent" =>
    /\ parent[epoch] = parent[0]
    /\ deadline[epoch] = deadline[0]

=============================================================================
