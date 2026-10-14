---------------------------- MODULE InputRetention ----------------------------
(* InputRetention proves durable serialized input retention for arbitrary references and input values (Safety, SerializedRetention). *)
(* AcceptedInput fixes the serialized value chosen at each reference's acceptance; runtime configuration and proposals are outside this abstraction. *)
(* stored represents durable values; loaded, running, cleaning, ready, and seenHandles are volatile. Hashing, serialization codecs, checkpoint encoding, external side effects, and TypeScript refinement are outside this proof. *)
(* Each reference has at most one durable handle; submitted and seenHandles abstract its presence. *)
(* cleanupAcknowledged projects successful CancellationSettled outcomes; typed failures and CancellationDied retain the cleanup obligation. This projection is intended correspondence, not a checked TypeScript refinement. *)
(* Acknowledge requires producer quiescence, successful cleanup of the final known handle, and durable forwarding completion (AcknowledgementRequiresSuccess). *)
EXTENDS TLAPS

CONSTANTS Refs, SerializedInputs, AcceptedInput
ASSUME InputsTyped == AcceptedInput \in [Refs -> SerializedInputs]

Payload(ref) == [ref |-> ref, value |-> AcceptedInput[ref]]
Payloads(ids) == {Payload(ref) : ref \in ids}

VARIABLES issued, unfinished, cancelled, cleanupAcknowledged, dead,
          stored, loaded, running, submitted, forwarding, cleaning, ready, seenHandles
vars == <<issued, unfinished, cancelled, cleanupAcknowledged, dead,
          stored, loaded, running, submitted, forwarding, cleaning, ready, seenHandles>>
CleanupNeeded == cancelled \ cleanupAcknowledged
NeedsInput == unfinished \cup CleanupNeeded

Init == /\ issued = {}
        /\ unfinished = {}
        /\ cancelled = {}
        /\ cleanupAcknowledged = {}
        /\ dead = {}
        /\ stored = {}
        /\ loaded = {}
        /\ running = {}
        /\ submitted = {}
        /\ forwarding = {}
        /\ cleaning = {}
        /\ ready = {}
        /\ seenHandles = {}

(* Accept makes input durable in the same commit that permits execution. *)
Accept(ref) == /\ ref \in Refs \ issued
               /\ issued' = issued \cup {ref}
               /\ unfinished' = unfinished \cup {ref}
               /\ stored' = stored \cup {Payload(ref)}
               /\ UNCHANGED <<cancelled, cleanupAcknowledged, dead, loaded, running,
                              submitted, forwarding, cleaning, ready, seenHandles>>
Hydrate(ref) == /\ ref \in NeedsInput
                /\ Payload(ref) \in stored
                /\ loaded' = loaded \cup {Payload(ref)}
                /\ UNCHANGED <<issued, unfinished, cancelled, cleanupAcknowledged, dead,
                               stored, running, submitted, forwarding, cleaning, ready, seenHandles>>
Start(ref) == /\ ref \in unfinished
              /\ Payload(ref) \in loaded
              /\ running' = running \cup {ref}
              /\ UNCHANGED <<issued, unfinished, cancelled, cleanupAcknowledged, dead,
                             stored, loaded, submitted, forwarding, cleaning, ready, seenHandles>>
(* Submit preserves unfinished work and durably records its handle before the producer stops. *)
Submit(ref) == /\ ref \in running
               /\ submitted' = submitted \cup {ref}
               /\ running' = running \ {ref}
               /\ UNCHANGED <<issued, unfinished, cancelled, cleanupAcknowledged, dead,
                              stored, loaded, forwarding, cleaning, ready, seenHandles>>
Finish(ref) == /\ ref \in unfinished
               /\ unfinished' = unfinished \ {ref}
               /\ running' = running \ {ref}
               /\ stored' = stored \ {Payload(ref)}
               /\ loaded' = loaded \ {Payload(ref)}
               /\ UNCHANGED <<issued, cancelled, cleanupAcknowledged, dead,
                              submitted, forwarding, cleaning, ready, seenHandles>>
(* Cancel transfers the input obligation to cleanup; the old producer may still be joining. *)
Cancel(ref) == /\ ref \in unfinished
               /\ unfinished' = unfinished \ {ref}
               /\ cancelled' = cancelled \cup {ref}
               /\ forwarding' = forwarding \cup {ref}
               /\ UNCHANGED <<issued, cleanupAcknowledged, dead, stored, loaded, running,
                              submitted, cleaning, ready, seenHandles>>
Join(ref) == /\ ref \in cancelled \cap running
             /\ running' = running \ {ref}
             /\ UNCHANGED <<issued, unfinished, cancelled, cleanupAcknowledged, dead,
                            stored, loaded, submitted, forwarding, cleaning, ready, seenHandles>>
(* Forward abstracts receipt of the required durable child-cancellation decisions (quint/cancellation.qnt, forwardingComplete). *)
Forward(ref) == /\ ref \in forwarding
                /\ forwarding' = forwarding \ {ref}
                /\ UNCHANGED <<issued, unfinished, cancelled, cleanupAcknowledged, dead,
                               stored, loaded, running, submitted, cleaning, ready, seenHandles>>
BeginCleanup(ref) == /\ ref \in CleanupNeeded \ (running \cup cleaning \cup ready)
                     /\ Payload(ref) \in loaded
                     /\ cleaning' = cleaning \cup {ref}
                     /\ seenHandles' = IF ref \in submitted THEN seenHandles \cup {ref} ELSE seenHandles \ {ref}
                     /\ UNCHANGED <<issued, unfinished, cancelled, cleanupAcknowledged, dead,
                                    stored, loaded, running, submitted, forwarding, ready>>
FailCleanup(ref) == /\ ref \in cleaning
                    /\ cleaning' = cleaning \ {ref}
                    /\ seenHandles' = seenHandles \ {ref}
                    /\ UNCHANGED <<issued, unfinished, cancelled, cleanupAcknowledged, dead,
                                   stored, loaded, running, submitted, forwarding, ready>>
SucceedCleanup(ref) == /\ ref \in cleaning \ forwarding
                       /\ cleaning' = cleaning \ {ref}
                       /\ ready' = ready \cup {ref}
                       /\ UNCHANGED <<issued, unfinished, cancelled, cleanupAcknowledged, dead,
                                      stored, loaded, running, submitted, forwarding, seenHandles>>
(* Acknowledge commits successful CancellationSettled and payload deletion atomically. *)
Acknowledge(ref) == /\ ref \in CleanupNeeded \cap ready
                    /\ ref \notin running \cup forwarding
                    /\ (ref \in submitted) = (ref \in seenHandles)
                    /\ cleanupAcknowledged' = cleanupAcknowledged \cup {ref}
                    /\ stored' = stored \ {Payload(ref)}
                    /\ loaded' = loaded \ {Payload(ref)}
                    /\ ready' = ready \ {ref}
                    /\ seenHandles' = seenHandles \ {ref}
                    /\ UNCHANGED <<issued, unfinished, cancelled, dead, running,
                                   submitted, forwarding, cleaning>>
(* Stop permanently ends execution for selected references without discharging their cancellation cleanup. *)
Stop(ids) == /\ ids \subseteq issued
             /\ dead' = dead \cup ids
             /\ unfinished' = unfinished \ ids
             /\ running' = running \ ids
             /\ stored' = stored \ Payloads(ids \ CleanupNeeded)
             /\ loaded' = loaded \ Payloads(ids \ CleanupNeeded)
             /\ UNCHANGED <<issued, cancelled, cleanupAcknowledged, submitted,
                            forwarding, cleaning, ready, seenHandles>>
Release(ref) == /\ ref \in issued \ NeedsInput
                /\ stored' = stored \ {Payload(ref)}
                /\ loaded' = loaded \ {Payload(ref)}
                /\ UNCHANGED <<issued, unfinished, cancelled, cleanupAcknowledged, dead,
                               running, submitted, forwarding, cleaning, ready, seenHandles>>
(* Crash discards process memory and preserves durable requests, payloads, handles, and acknowledgements. *)
Crash == /\ loaded' = {}
         /\ running' = {}
         /\ cleaning' = {}
         /\ ready' = {}
         /\ seenHandles' = {}
         /\ UNCHANGED <<issued, unfinished, cancelled, cleanupAcknowledged, dead, stored, submitted, forwarding>>
Next == \/ \E ref \in Refs: Accept(ref) \/ Hydrate(ref) \/ Start(ref) \/ Submit(ref) \/ Finish(ref)
                            \/ Cancel(ref) \/ Join(ref) \/ Forward(ref) \/ BeginCleanup(ref)
                            \/ FailCleanup(ref) \/ SucceedCleanup(ref) \/ Acknowledge(ref) \/ Release(ref)
        \/ \E ids \in SUBSET Refs: Stop(ids)
        \/ Crash
Spec == Init /\ [][Next]_vars

TypeOK == /\ issued \subseteq Refs
          /\ unfinished \subseteq issued
          /\ cancelled \subseteq issued
          /\ cleanupAcknowledged \subseteq cancelled
          /\ dead \subseteq issued
          /\ submitted \subseteq issued
          /\ stored \subseteq Payloads(issued)
          /\ loaded \subseteq stored
          /\ running \subseteq NeedsInput
          /\ forwarding \subseteq CleanupNeeded
          /\ cleaning \cup ready \subseteq CleanupNeeded
          /\ seenHandles \subseteq cleaning \cup ready
Disjoint == /\ unfinished \cap cancelled = {}
            /\ unfinished \cap dead = {}
            /\ cleaning \cap ready = {}
            /\ (cleaning \cup ready) \cap running = {}
Retention == Payloads(NeedsInput) \subseteq stored
Acknowledged == /\ Payloads(cleanupAcknowledged) \cap stored = {}
                /\ cleanupAcknowledged \cap running = {}
Invariant == TypeOK /\ Disjoint /\ Retention /\ Acknowledged

THEOREM InitialInvariant == Init => Invariant
BY SMT DEF Init, Invariant, TypeOK, Disjoint, Retention, Acknowledged, Payloads, Payload, NeedsInput, CleanupNeeded

THEOREM StepInvariant == Invariant /\ [Next]_vars => Invariant'
BY SMT DEF Invariant, TypeOK, Disjoint, Retention, Acknowledged, Payloads, Payload, NeedsInput, CleanupNeeded,
           Next, Accept, Hydrate, Start, Submit, Finish, Cancel, Join, Forward, BeginCleanup,
           FailCleanup, SucceedCleanup, Acknowledge, Stop, Release, Crash, vars

THEOREM Safety == Spec => []Invariant
BY PTL, InitialInvariant, StepInvariant DEF Spec

SerializedInputAvailable ==
  \A ref \in NeedsInput: \E payload \in stored:
    payload.ref = ref /\ payload.value = AcceptedInput[ref] /\ payload.value \in SerializedInputs
THEOREM SerializedRetention == Invariant => SerializedInputAvailable
BY SMT, InputsTyped DEF Invariant, TypeOK, Retention, Payloads, Payload, NeedsInput, CleanupNeeded, SerializedInputAvailable

THEOREM DurableSerializedSafety == Spec => []SerializedInputAvailable
BY PTL, Safety, SerializedRetention

THEOREM AcknowledgementRequiresSuccess ==
  \A ref \in Refs: Invariant /\ Acknowledge(ref) =>
    ref \in ready /\ ref \notin running \cup forwarding /\ ((ref \in submitted) = (ref \in seenHandles))
BY SMT DEF Acknowledge

THEOREM ReadinessRequiresSuccessfulCleanup ==
  \A ref \in Refs: Next /\ ref \in ready' \ ready => SucceedCleanup(ref)
BY SMT DEF Next, Accept, Hydrate, Start, Submit, Finish, Cancel, Join, Forward, BeginCleanup,
           FailCleanup, SucceedCleanup, Acknowledge, Stop, Release, Crash

THEOREM NewAcknowledgementRequiresSuccess ==
  \A ref \in Refs: Next /\ ref \in cleanupAcknowledged' \ cleanupAcknowledged =>
    ref \in ready /\ ref \notin running \cup forwarding /\ ((ref \in submitted) = (ref \in seenHandles))
BY SMT DEF Next, Accept, Hydrate, Start, Submit, Finish, Cancel, Join, Forward, BeginCleanup,
           FailCleanup, SucceedCleanup, Acknowledge, Stop, Release, Crash

THEOREM AcknowledgePreservesOtherInputs ==
  \A ref \in Refs: \A other \in NeedsInput \ {ref}:
    Invariant /\ Acknowledge(ref) => Payload(other) \in stored'
BY SMT DEF Invariant, Retention, Payloads, Payload, Acknowledge

THEOREM StopPreservesCleanup ==
  \A ids \in SUBSET Refs: Invariant /\ Stop(ids) =>
    CleanupNeeded' = CleanupNeeded /\ Payloads(CleanupNeeded) \subseteq stored'
BY SMT DEF Invariant, Retention, Stop, Payloads, Payload, NeedsInput, CleanupNeeded

THEOREM RecoveryStability == Crash =>
  /\ cleanupAcknowledged' = cleanupAcknowledged
  /\ CleanupNeeded' = CleanupNeeded
  /\ NeedsInput' = NeedsInput
  /\ stored' = stored
BY SMT DEF Crash, CleanupNeeded, NeedsInput

THEOREM NoAcknowledgedCleanup == Invariant =>
  /\ cleanupAcknowledged \cap CleanupNeeded = {}
  /\ cleanupAcknowledged \cap (cleaning \cup ready) = {}
BY SMT DEF Invariant, TypeOK, CleanupNeeded

=============================================================================
