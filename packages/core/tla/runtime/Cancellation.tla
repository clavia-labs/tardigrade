--------------------------- MODULE Cancellation ---------------------------
(* Cancellation models the durable cut indexed by ActorInvocation. *)

EXTENDS FiniteSets, Naturals, TLC

CONSTANTS Invocations, Effects, Calls, Links, RequestIds, Target

MessageInvocation == [method |-> "message", id |-> "m1", epoch |-> 0]
NextMessageInvocation == [method |-> "message", id |-> "m1", epoch |-> 1]
InspectInvocation == [method |-> "inspect", id |-> "m1", epoch |-> 0]
ModelInvocations == {MessageInvocation, NextMessageInvocation, InspectInvocation}
ModelLinks == {<<MessageInvocation, InspectInvocation>>}

ASSUME Invocations \subseteq [method: STRING, id: STRING, epoch: Nat]
ASSUME IsFiniteSet(Invocations)
ASSUME IsFiniteSet(Effects)
ASSUME IsFiniteSet(Calls)
ASSUME Links \subseteq Invocations \X Invocations
ASSUME IsFiniteSet(RequestIds)
ASSUME Target \in Invocations

VARIABLES phase,
          cancellationRequests,
          requestAcks,
          startedEffects,
          activeEffects,
          effectsAtRequest,
          signalsOwed,
          signalledEffects,
          openedCalls,
          openCalls,
          callsAtRequest,
          terminatedCalls,
          linkedChildren,
          liveInvocations,
          childrenAtRequest,
          childRequests,
          cancelledChildren

vars == <<phase,
          cancellationRequests,
          requestAcks,
          startedEffects,
          activeEffects,
          effectsAtRequest,
          signalsOwed,
          signalledEffects,
          openedCalls,
          openCalls,
          callsAtRequest,
          terminatedCalls,
          linkedChildren,
          liveInvocations,
          childrenAtRequest,
          childRequests,
          cancelledChildren>>

InvocationEffects == Invocations \X Effects
InvocationCalls == Invocations \X Calls
RequestTargets == RequestIds \X Invocations

ForInvocation(relation, invocation) ==
  {pair \in relation : pair[1] = invocation}

ChildrenOf(relation, invocation) ==
  {link \in relation : link[1] = invocation}

TypeOK ==
  /\ phase \in [Invocations -> {"running", "requested", "cancelled"}]
  /\ cancellationRequests \subseteq Invocations
  /\ requestAcks \subseteq RequestTargets
  /\ startedEffects \subseteq InvocationEffects
  /\ activeEffects \subseteq startedEffects
  /\ effectsAtRequest \subseteq startedEffects
  /\ signalsOwed \subseteq effectsAtRequest
  /\ signalledEffects \subseteq signalsOwed
  /\ openedCalls \subseteq InvocationCalls
  /\ openCalls \subseteq openedCalls
  /\ callsAtRequest \subseteq openedCalls
  /\ terminatedCalls \subseteq callsAtRequest
  /\ linkedChildren \subseteq Links
  /\ liveInvocations \subseteq Invocations
  /\ childrenAtRequest \subseteq linkedChildren
  /\ childRequests \subseteq childrenAtRequest
  /\ cancelledChildren \subseteq childRequests

Init ==
  /\ phase = [invocation \in Invocations |-> "running"]
  /\ cancellationRequests = {}
  /\ requestAcks = {}
  /\ startedEffects = {}
  /\ activeEffects = {}
  /\ effectsAtRequest = {}
  /\ signalsOwed = {}
  /\ signalledEffects = {}
  /\ openedCalls = {}
  /\ openCalls = {}
  /\ callsAtRequest = {}
  /\ terminatedCalls = {}
  /\ linkedChildren = {}
  /\ liveInvocations = {}
  /\ childrenAtRequest = {}
  /\ childRequests = {}
  /\ cancelledChildren = {}

StartEffect(invocation, effect) ==
  /\ phase[invocation] = "running"
  /\ <<invocation, effect>> \notin startedEffects
  /\ startedEffects' = startedEffects \cup {<<invocation, effect>>}
  /\ activeEffects' = activeEffects \cup {<<invocation, effect>>}
  /\ UNCHANGED <<phase, cancellationRequests, requestAcks, effectsAtRequest,
                  signalsOwed, signalledEffects, openedCalls, openCalls,
                  callsAtRequest, terminatedCalls, linkedChildren,
                  liveInvocations, childrenAtRequest, childRequests,
                  cancelledChildren>>

FinishEffect(invocation, effect) ==
  /\ <<invocation, effect>> \in activeEffects
  /\ activeEffects' = activeEffects \ {<<invocation, effect>>}
  /\ UNCHANGED <<phase, cancellationRequests, requestAcks, startedEffects,
                  effectsAtRequest, signalsOwed, signalledEffects, openedCalls,
                  openCalls, callsAtRequest, terminatedCalls, linkedChildren,
                  liveInvocations, childrenAtRequest, childRequests,
                  cancelledChildren>>

OpenCall(invocation, call) ==
  /\ phase[invocation] = "running"
  /\ <<invocation, call>> \notin openedCalls
  /\ openedCalls' = openedCalls \cup {<<invocation, call>>}
  /\ openCalls' = openCalls \cup {<<invocation, call>>}
  /\ UNCHANGED <<phase, cancellationRequests, requestAcks, startedEffects,
                  activeEffects, effectsAtRequest, signalsOwed,
                  signalledEffects, callsAtRequest, terminatedCalls,
                  linkedChildren, liveInvocations, childrenAtRequest,
                  childRequests, cancelledChildren>>

CompleteCall(invocation, call) ==
  /\ phase[invocation] = "running"
  /\ <<invocation, call>> \in openCalls
  /\ openCalls' = openCalls \ {<<invocation, call>>}
  /\ UNCHANGED <<phase, cancellationRequests, requestAcks, startedEffects,
                  activeEffects, effectsAtRequest, signalsOwed,
                  signalledEffects, openedCalls, callsAtRequest,
                  terminatedCalls, linkedChildren, liveInvocations,
                  childrenAtRequest, childRequests, cancelledChildren>>

LinkChild(link) ==
  /\ link \in Links \ linkedChildren
  /\ phase[link[1]] = "running"
  /\ linkedChildren' = linkedChildren \cup {link}
  /\ liveInvocations' = liveInvocations \cup {link[2]}
  /\ UNCHANGED <<phase, cancellationRequests, requestAcks, startedEffects,
                  activeEffects, effectsAtRequest, signalsOwed,
                  signalledEffects, openedCalls, openCalls, callsAtRequest,
                  terminatedCalls, childrenAtRequest, childRequests,
                  cancelledChildren>>

CompleteChild(link) ==
  /\ link \in linkedChildren
  /\ phase[link[1]] = "running"
  /\ link[2] \in liveInvocations
  /\ liveInvocations' = liveInvocations \ {link[2]}
  /\ UNCHANGED <<phase, cancellationRequests, requestAcks, startedEffects,
                  activeEffects, effectsAtRequest, signalsOwed,
                  signalledEffects, openedCalls, openCalls, callsAtRequest,
                  terminatedCalls, linkedChildren, childrenAtRequest,
                  childRequests, cancelledChildren>>

FirstCancellationRequest(invocation) ==
  /\ phase' = [phase EXCEPT ![invocation] = "requested"]
  /\ cancellationRequests' = cancellationRequests \cup {invocation}
  /\ effectsAtRequest' = effectsAtRequest \cup ForInvocation(startedEffects, invocation)
  /\ signalsOwed' = signalsOwed \cup ForInvocation(activeEffects, invocation)
  /\ callsAtRequest' = callsAtRequest \cup ForInvocation(openCalls, invocation)
  /\ childrenAtRequest' = childrenAtRequest \cup
      {link \in linkedChildren : link[1] = invocation /\ link[2] \in liveInvocations}

RequestCancellation(invocation, request) ==
  /\ <<request, invocation>> \notin requestAcks
  /\ requestAcks' = requestAcks \cup {<<request, invocation>>}
  /\ IF invocation \in cancellationRequests
      THEN UNCHANGED <<phase, cancellationRequests, effectsAtRequest,
                       signalsOwed, callsAtRequest, childrenAtRequest>>
      ELSE FirstCancellationRequest(invocation)
  /\ UNCHANGED <<startedEffects, activeEffects, signalledEffects,
                  openedCalls, openCalls, terminatedCalls, linkedChildren,
                  liveInvocations, childRequests, cancelledChildren>>

SignalEffect(pair) ==
  /\ pair \in signalsOwed \ signalledEffects
  /\ phase[pair[1]] = "requested"
  /\ signalledEffects' = signalledEffects \cup {pair}
  /\ UNCHANGED <<phase, cancellationRequests, requestAcks, startedEffects,
                  activeEffects, effectsAtRequest, signalsOwed, openedCalls,
                  openCalls, callsAtRequest, terminatedCalls, linkedChildren,
                  liveInvocations, childrenAtRequest, childRequests,
                  cancelledChildren>>

TerminateCall(pair) ==
  /\ pair \in callsAtRequest \ terminatedCalls
  /\ phase[pair[1]] = "requested"
  /\ terminatedCalls' = terminatedCalls \cup {pair}
  /\ openCalls' = openCalls \ {pair}
  /\ UNCHANGED <<phase, cancellationRequests, requestAcks, startedEffects,
                  activeEffects, effectsAtRequest, signalsOwed,
                  signalledEffects, openedCalls, callsAtRequest,
                  linkedChildren, liveInvocations, childrenAtRequest,
                  childRequests, cancelledChildren>>

RequestChild(link) ==
  /\ link \in childrenAtRequest \ childRequests
  /\ phase[link[1]] = "requested"
  /\ childRequests' = childRequests \cup {link}
  /\ IF link[2] \in cancellationRequests
      THEN UNCHANGED <<phase, cancellationRequests, effectsAtRequest,
                       signalsOwed, callsAtRequest, childrenAtRequest>>
      ELSE FirstCancellationRequest(link[2])
  /\ UNCHANGED <<requestAcks, startedEffects, activeEffects,
                  signalledEffects, openedCalls, openCalls, terminatedCalls,
                  linkedChildren, liveInvocations, cancelledChildren>>

AcknowledgeChild(link) ==
  /\ link \in childRequests \ cancelledChildren
  /\ phase[link[2]] = "cancelled"
  /\ cancelledChildren' = cancelledChildren \cup {link}
  /\ liveInvocations' = liveInvocations \ {link[2]}
  /\ UNCHANGED <<phase, cancellationRequests, requestAcks, startedEffects,
                  activeEffects, effectsAtRequest, signalsOwed,
                  signalledEffects, openedCalls, openCalls, callsAtRequest,
                  terminatedCalls, linkedChildren, childrenAtRequest,
                  childRequests>>

CleanupComplete(invocation) ==
  /\ ForInvocation(signalsOwed, invocation) \subseteq signalledEffects
  /\ ForInvocation(callsAtRequest, invocation) \subseteq terminatedCalls
  /\ ChildrenOf(childrenAtRequest, invocation) \subseteq cancelledChildren

SettleCancellation(invocation) ==
  /\ phase[invocation] = "requested"
  /\ CleanupComplete(invocation)
  /\ phase' = [phase EXCEPT ![invocation] = "cancelled"]
  /\ UNCHANGED <<cancellationRequests, requestAcks, startedEffects,
                  activeEffects, effectsAtRequest, signalsOwed,
                  signalledEffects, openedCalls, openCalls, callsAtRequest,
                  terminatedCalls, linkedChildren, liveInvocations,
                  childrenAtRequest, childRequests, cancelledChildren>>

StartSomeEffect ==
  \E effect \in Effects : StartEffect(Target, effect)
FinishSomeEffect ==
  \E effect \in Effects : FinishEffect(Target, effect)
OpenSomeCall ==
  \E call \in Calls : OpenCall(Target, call)
CompleteSomeCall ==
  \E call \in Calls : CompleteCall(Target, call)
LinkSomeChild == \E link \in Links : LinkChild(link)
CompleteSomeChild == \E link \in Links : CompleteChild(link)
RequestSomeCancellation ==
  \E request \in RequestIds : RequestCancellation(Target, request)
SignalSomeEffect == \E pair \in signalsOwed : SignalEffect(pair)
TerminateSomeCall == \E pair \in callsAtRequest : TerminateCall(pair)
RequestSomeChild == \E link \in childrenAtRequest : RequestChild(link)
AcknowledgeSomeChild == \E link \in childRequests : AcknowledgeChild(link)
SettleSomeCancellation ==
  \E invocation \in cancellationRequests : SettleCancellation(invocation)

Next ==
  \/ StartSomeEffect
  \/ FinishSomeEffect
  \/ OpenSomeCall
  \/ CompleteSomeCall
  \/ LinkSomeChild
  \/ CompleteSomeChild
  \/ RequestSomeCancellation
  \/ SignalSomeEffect
  \/ TerminateSomeCall
  \/ RequestSomeChild
  \/ AcknowledgeSomeChild
  \/ SettleSomeCancellation

FairCleanup ==
  /\ WF_vars(RequestSomeCancellation)
  /\ WF_vars(SignalSomeEffect)
  /\ WF_vars(TerminateSomeCall)
  /\ WF_vars(RequestSomeChild)
  /\ WF_vars(AcknowledgeSomeChild)
  /\ WF_vars(SettleSomeCancellation)

Spec == Init /\ [][Next]_vars /\ FairCleanup

(* Effect admission after the exact invocation request violates NoNewEffects. *)
StartEffectAfterRequest(invocation, effect) ==
  /\ invocation \in cancellationRequests
  /\ <<invocation, effect>> \notin startedEffects
  /\ startedEffects' = startedEffects \cup {<<invocation, effect>>}
  /\ activeEffects' = activeEffects \cup {<<invocation, effect>>}
  /\ UNCHANGED <<phase, cancellationRequests, requestAcks, effectsAtRequest,
                  signalsOwed, signalledEffects, openedCalls, openCalls,
                  callsAtRequest, terminatedCalls, linkedChildren,
                  liveInvocations, childrenAtRequest, childRequests,
                  cancelledChildren>>

NextEffectLeak == Next \/
  \E invocation \in Invocations, effect \in Effects :
    StartEffectAfterRequest(invocation, effect)
SpecEffectLeak == Init /\ [][NextEffectLeak]_vars /\ FairCleanup

SettleWithoutSignals(invocation) ==
  /\ phase[invocation] = "requested"
  /\ ForInvocation(callsAtRequest, invocation) \subseteq terminatedCalls
  /\ ChildrenOf(childrenAtRequest, invocation) \subseteq cancelledChildren
  /\ phase' = [phase EXCEPT ![invocation] = "cancelled"]
  /\ UNCHANGED <<cancellationRequests, requestAcks, startedEffects,
                  activeEffects, effectsAtRequest, signalsOwed,
                  signalledEffects, openedCalls, openCalls, callsAtRequest,
                  terminatedCalls, linkedChildren, liveInvocations,
                  childrenAtRequest, childRequests, cancelledChildren>>

NextWithoutSignals ==
  \/ StartSomeEffect \/ FinishSomeEffect \/ OpenSomeCall \/ CompleteSomeCall
  \/ LinkSomeChild \/ CompleteSomeChild \/ RequestSomeCancellation
  \/ SignalSomeEffect \/ TerminateSomeCall \/ RequestSomeChild
  \/ AcknowledgeSomeChild
  \/ \E invocation \in cancellationRequests : SettleWithoutSignals(invocation)
SpecWithoutSignals == Init /\ [][NextWithoutSignals]_vars /\ FairCleanup

SettleWithOpenCalls(invocation) ==
  /\ phase[invocation] = "requested"
  /\ ForInvocation(signalsOwed, invocation) \subseteq signalledEffects
  /\ ChildrenOf(childrenAtRequest, invocation) \subseteq cancelledChildren
  /\ phase' = [phase EXCEPT ![invocation] = "cancelled"]
  /\ UNCHANGED <<cancellationRequests, requestAcks, startedEffects,
                  activeEffects, effectsAtRequest, signalsOwed,
                  signalledEffects, openedCalls, openCalls, callsAtRequest,
                  terminatedCalls, linkedChildren, liveInvocations,
                  childrenAtRequest, childRequests, cancelledChildren>>

NextWithOpenCalls ==
  \/ StartSomeEffect \/ FinishSomeEffect \/ OpenSomeCall \/ CompleteSomeCall
  \/ LinkSomeChild \/ CompleteSomeChild \/ RequestSomeCancellation
  \/ SignalSomeEffect \/ TerminateSomeCall \/ RequestSomeChild
  \/ AcknowledgeSomeChild
  \/ \E invocation \in cancellationRequests : SettleWithOpenCalls(invocation)
SpecWithOpenCalls == Init /\ [][NextWithOpenCalls]_vars /\ FairCleanup

SettleWithoutChildCancellation(invocation) ==
  /\ phase[invocation] = "requested"
  /\ ForInvocation(signalsOwed, invocation) \subseteq signalledEffects
  /\ ForInvocation(callsAtRequest, invocation) \subseteq terminatedCalls
  /\ phase' = [phase EXCEPT ![invocation] = "cancelled"]
  /\ UNCHANGED <<cancellationRequests, requestAcks, startedEffects,
                  activeEffects, effectsAtRequest, signalsOwed,
                  signalledEffects, openedCalls, openCalls, callsAtRequest,
                  terminatedCalls, linkedChildren, liveInvocations,
                  childrenAtRequest, childRequests, cancelledChildren>>

NextWithoutChildCancellation ==
  \/ StartSomeEffect \/ FinishSomeEffect \/ OpenSomeCall \/ CompleteSomeCall
  \/ LinkSomeChild \/ CompleteSomeChild \/ RequestSomeCancellation
  \/ SignalSomeEffect \/ TerminateSomeCall \/ RequestSomeChild
  \/ AcknowledgeSomeChild
  \/ \E invocation \in cancellationRequests :
       SettleWithoutChildCancellation(invocation)
SpecWithoutChildCancellation ==
  Init /\ [][NextWithoutChildCancellation]_vars /\ FairCleanup

NextWithoutSettlement ==
  \/ StartSomeEffect \/ FinishSomeEffect \/ OpenSomeCall \/ CompleteSomeCall
  \/ LinkSomeChild \/ CompleteSomeChild \/ RequestSomeCancellation
  \/ SignalSomeEffect \/ TerminateSomeCall \/ RequestSomeChild
  \/ AcknowledgeSomeChild

FairCleanupWithoutSettlement ==
  /\ WF_vars(RequestSomeCancellation)
  /\ WF_vars(SignalSomeEffect)
  /\ WF_vars(TerminateSomeCall)
  /\ WF_vars(RequestSomeChild)
  /\ WF_vars(AcknowledgeSomeChild)

SpecWithoutSettlement ==
  Init /\ [][NextWithoutSettlement]_vars /\ FairCleanupWithoutSettlement

(* A child that never acknowledges leaves its parent cancellation pending. *)
NextWithoutChildAcknowledgement ==
  \/ StartSomeEffect \/ FinishSomeEffect \/ OpenSomeCall \/ CompleteSomeCall
  \/ LinkSomeChild \/ CompleteSomeChild \/ RequestSomeCancellation
  \/ SignalSomeEffect \/ TerminateSomeCall \/ RequestSomeChild
  \/ SettleSomeCancellation

FairCleanupWithoutChildAcknowledgement ==
  /\ WF_vars(RequestSomeCancellation)
  /\ WF_vars(SignalSomeEffect)
  /\ WF_vars(TerminateSomeCall)
  /\ WF_vars(RequestSomeChild)
  /\ WF_vars(SettleSomeCancellation)

SpecWithoutChildAcknowledgement ==
  Init /\ [][NextWithoutChildAcknowledgement]_vars
    /\ FairCleanupWithoutChildAcknowledgement

(* Matching only id leaks one request across method and epoch boundaries. *)
RequestCancellationById(invocation, request) ==
  LET matching == {candidate \in Invocations : candidate.id = invocation.id}
  IN
    /\ <<request, invocation>> \notin requestAcks
    /\ requestAcks' = requestAcks \cup {<<request, invocation>>}
    /\ cancellationRequests' = cancellationRequests \cup matching
    /\ phase' = [candidate \in Invocations |->
         IF candidate \in matching /\ phase[candidate] = "running"
           THEN "requested"
           ELSE phase[candidate]]
    /\ effectsAtRequest' = effectsAtRequest \cup
         {pair \in startedEffects : pair[1] \in matching}
    /\ signalsOwed' = signalsOwed \cup
         {pair \in activeEffects : pair[1] \in matching}
    /\ callsAtRequest' = callsAtRequest \cup
         {pair \in openCalls : pair[1] \in matching}
    /\ childrenAtRequest' = childrenAtRequest \cup
         {link \in linkedChildren : link[1] \in matching /\ link[2] \in liveInvocations}
    /\ UNCHANGED <<startedEffects, activeEffects, signalledEffects,
                    openedCalls, openCalls, terminatedCalls, linkedChildren,
                    liveInvocations, childRequests, cancelledChildren>>

RequestSomeCancellationById ==
  \E request \in RequestIds : RequestCancellationById(Target, request)

NextIdentityLeak ==
  \/ StartSomeEffect \/ FinishSomeEffect \/ OpenSomeCall \/ CompleteSomeCall
  \/ LinkSomeChild \/ CompleteSomeChild \/ RequestSomeCancellationById
  \/ SignalSomeEffect \/ TerminateSomeCall \/ RequestSomeChild
  \/ AcknowledgeSomeChild \/ SettleSomeCancellation

SpecIdentityLeak == Init /\ [][NextIdentityLeak]_vars

---------------------------------------------------------------------------
NoNewEffects ==
  \A invocation \in cancellationRequests :
    ForInvocation(startedEffects, invocation) =
      ForInvocation(effectsAtRequest, invocation)

OldEffectsSignalled ==
  \A invocation \in Invocations :
    phase[invocation] # "cancelled" \/
      ForInvocation(signalsOwed, invocation) \subseteq signalledEffects

OpenCallsTerminated ==
  \A invocation \in Invocations :
    phase[invocation] # "cancelled" \/
      ForInvocation(callsAtRequest, invocation) \subseteq terminatedCalls

ChildrenCancelled ==
  \A invocation \in Invocations :
    phase[invocation] # "cancelled" \/
      ChildrenOf(childrenAtRequest, invocation) \subseteq cancelledChildren

InvocationCancelledLast ==
  \A invocation \in Invocations :
    phase[invocation] # "cancelled" \/ CleanupComplete(invocation)

ExactRequestTarget ==
  \A invocation \in cancellationRequests :
    \/ \E ack \in requestAcks : ack[2] = invocation
    \/ \E link \in childRequests : link[2] = invocation

DuplicateRequestsAbsorb ==
  \A ack \in requestAcks : ack[2] \in cancellationRequests

CancellationSettles ==
  \A invocation \in Invocations :
    (phase[invocation] = "requested") ~> (phase[invocation] = "cancelled")

===========================================================================
