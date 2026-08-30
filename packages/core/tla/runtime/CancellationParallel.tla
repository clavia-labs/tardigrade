---------------------- MODULE CancellationParallel ----------------------
(* CancellationParallel models cleanup obligations that wait for their peers to start. *)

EXTENDS FiniteSets, TLC

CONSTANT Obligations

ASSUME Obligations /= {}
ASSUME IsFiniteSet(Obligations)

VARIABLES phase, started, active, finished

vars == <<phase, started, active, finished>>

Init ==
  /\ phase = "requested"
  /\ started = {}
  /\ active = {}
  /\ finished = {}

Start(obligation) ==
  /\ phase = "requested"
  /\ obligation \in Obligations \ started
  /\ started' = started \cup {obligation}
  /\ active' = active \cup {obligation}
  /\ UNCHANGED <<phase, finished>>

StartSerial(obligation) ==
  /\ active = {}
  /\ Start(obligation)

Finish(obligation) ==
  /\ started = Obligations
  /\ obligation \in active
  /\ active' = active \ {obligation}
  /\ finished' = finished \cup {obligation}
  /\ UNCHANGED <<phase, started>>

Settle ==
  /\ phase = "requested"
  /\ finished = Obligations
  /\ phase' = "cancelled"
  /\ UNCHANGED <<started, active, finished>>

StartAny == \E obligation \in Obligations : Start(obligation)
StartSerialAny == \E obligation \in Obligations : StartSerial(obligation)
FinishAny == \E obligation \in Obligations : Finish(obligation)

Next == StartAny \/ FinishAny \/ Settle
NextSerial == StartSerialAny \/ FinishAny \/ Settle

Spec ==
  Init /\ [][Next]_vars
    /\ WF_vars(StartAny)
    /\ WF_vars(FinishAny)
    /\ WF_vars(Settle)

SpecSerial ==
  Init /\ [][NextSerial]_vars
    /\ WF_vars(StartSerialAny)
    /\ WF_vars(FinishAny)
    /\ WF_vars(Settle)

TypeOK ==
  /\ phase \in {"requested", "cancelled"}
  /\ started \subseteq Obligations
  /\ active \subseteq started
  /\ finished \subseteq started
  /\ active \cap finished = {}

CancellationSettles ==
  (phase = "requested") ~> (phase = "cancelled")

===========================================================================
