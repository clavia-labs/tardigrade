-------------------------- MODULE ResponseIdentity --------------------------
(* ResponseIdentity proves occurrence-bound settlement for an abstract response protocol (Safety, CommitPreservesOtherRequests). *)
EXTENDS TLAPS

CONSTANT Requests
Envelopes == [origin: Requests, target: Requests]
Bound(values) == \A value \in values: value.target = value.origin

VARIABLES issued, pending, callbacks, drafts, selected, committed
vars == <<issued, pending, callbacks, drafts, selected, committed>>

Init == /\ issued = {}
        /\ pending = {}
        /\ callbacks = {}
        /\ drafts = {}
        /\ selected = {}
        /\ committed = {}
Request(id) == /\ id \in Requests \ issued
               /\ issued' = issued \cup {id}
               /\ pending' = pending \cup {id}
               /\ UNCHANGED <<callbacks, drafts, selected, committed>>
Capture(id) == /\ id \in pending
               /\ callbacks' = callbacks \cup {[origin |-> id, target |-> id]}
               /\ UNCHANGED <<issued, pending, drafts, selected, committed>>
Respond(callback) == /\ callback \in callbacks
                     /\ drafts' = drafts \cup {callback}
                     /\ UNCHANGED <<issued, pending, callbacks, selected, committed>>
Publish(draft) == /\ draft \in drafts
                  /\ selected' = selected \cup {draft}
                  /\ UNCHANGED <<issued, pending, callbacks, drafts, committed>>
Withhold(draft) == /\ draft \in selected
                   /\ selected' = selected \ {draft}
                   /\ UNCHANGED <<issued, pending, callbacks, drafts, committed>>
Commit(draft) == /\ draft \in selected
                 /\ pending' = pending \ {draft.target}
                 /\ committed' = committed \cup {draft}
                 /\ UNCHANGED <<issued, callbacks, drafts, selected>>
Cleanup(ids) == /\ ids \subseteq pending
                /\ pending' = pending \ ids
                /\ UNCHANGED <<issued, callbacks, drafts, selected, committed>>
(* Restart assumes exact reconstruction of durable issued and pending state. *)
Restart == /\ callbacks' = {}
           /\ drafts' = {}
           /\ selected' = {}
           /\ UNCHANGED <<issued, pending, committed>>
Next == \/ \E id \in Requests: Request(id) \/ Capture(id)
        \/ \E value \in Envelopes: Respond(value) \/ Publish(value) \/ Withhold(value) \/ Commit(value)
        \/ \E ids \in SUBSET Requests: Cleanup(ids)
        \/ Restart
Spec == Init /\ [][Next]_vars

TypeOK == /\ issued \subseteq Requests
          /\ pending \subseteq issued
          /\ callbacks \subseteq Envelopes
          /\ drafts \subseteq callbacks
          /\ selected \subseteq drafts
          /\ committed \subseteq Envelopes
Invariant == TypeOK /\ Bound(callbacks) /\ Bound(committed)

THEOREM InitialInvariant == Init => Invariant
BY SMT DEF Init, Invariant, TypeOK, Bound, Envelopes

THEOREM StepInvariant == Invariant /\ [Next]_vars => Invariant'
BY SMT DEF Invariant, TypeOK, Bound, Envelopes, Next, Request, Capture,
           Respond, Publish, Withhold, Commit, Cleanup, Restart, vars

THEOREM Safety == Spec => []Invariant
BY PTL, InitialInvariant, StepInvariant DEF Spec

THEOREM CommitPreservesOtherRequests ==
  \A draft \in Envelopes, other \in Requests:
    Invariant /\ Commit(draft) /\ other # draft.origin =>
      (other \in pending' <=> other \in pending)
BY SMT DEF Invariant, TypeOK, Bound, Commit, Envelopes

=============================================================================
