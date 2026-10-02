------------------------- MODULE ForkPublication -------------------------
(* ForkPublication models destination reservation, initial publication, startup scheduling, and recovery (ForkPublication.cfg, ForkPublicationBareRoot.cfg). *)
EXTENDS Naturals, Sequences

CONSTANT Mode
ASSUME Mode \in {"atomic", "bare-root"}

VARIABLES reserved, published, online, log, crashes
vars == <<reserved, published, online, log, crashes>>

InitialImage == <<"ThreadCreated", "CopiedHistory", "ThreadForked", "Detachments">>

Init ==
  /\ reserved = FALSE
  /\ published = FALSE
  /\ online = FALSE
  /\ log = <<>>
  /\ crashes = 0

Reserve ==
  /\ ~reserved
  /\ reserved' = TRUE
  /\ online' = TRUE
  /\ UNCHANGED <<published, log, crashes>>

InitializeBareRoot ==
  /\ Mode = "bare-root"
  /\ reserved /\ online /\ log = <<>>
  /\ log' = <<"ThreadCreated">>
  /\ UNCHANGED <<reserved, published, online, crashes>>

Publish ==
  /\ reserved /\ online /\ ~published
  /\ log = IF Mode = "atomic" THEN <<>> ELSE <<"ThreadCreated">>
  /\ log' = InitialImage
  /\ published' = TRUE
  /\ UNCHANGED <<reserved, online, crashes>>

Startup ==
  /\ reserved /\ online
  /\ Len(log) > 0
  /\ log[1] = "ThreadCreated"
  /\ ~("Booted" \in {log[n] : n \in DOMAIN log})
  /\ log' = Append(log, "Booted")
  /\ UNCHANGED <<reserved, published, online, crashes>>

Crash ==
  /\ online /\ crashes = 0
  /\ online' = FALSE
  /\ crashes' = 1
  /\ UNCHANGED <<reserved, published, log>>

Recover ==
  /\ reserved /\ ~online
  /\ online' = TRUE
  /\ UNCHANGED <<reserved, published, log, crashes>>

Next == Reserve \/ InitializeBareRoot \/ Publish \/ Startup \/ Crash \/ Recover
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ reserved \in BOOLEAN /\ published \in BOOLEAN /\ online \in BOOLEAN
  /\ log \in Seq({"ThreadCreated", "CopiedHistory", "ThreadForked", "Detachments", "Booted"})
  /\ crashes \in 0..1

NoExecutionBeforePublication == ("Booted" \in {log[n] : n \in DOMAIN log}) => published
CompletePublication == published =>
  IF Len(log) < Len(InitialImage) THEN FALSE
  ELSE SubSeq(log, 1, Len(InitialImage)) = InitialImage
=============================================================================
