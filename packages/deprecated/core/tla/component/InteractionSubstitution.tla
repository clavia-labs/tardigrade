--------------------- MODULE InteractionSubstitution ---------------------
(* InteractionSubstitution compares an incremental child with a history-derived child through a finite parent command language (InteractionSubstitution.cfg). *)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Slots, Versions, MaxEvents, MaxEffects, Fault, None, Rejected
Sides == {"incremental", "replay"}
Left == "incremental"
Right == "replay"
Modes == {"allow", "wait", "reject"}
Idle == [version |-> 0, phase |-> "idle", value |-> 0]
Empty == [slot \in Slots |-> Idle]
Event(kind, slot, version, value) == [kind |-> kind, slot |-> slot, version |-> version, value |-> value]
Key(event) == <<event.kind, event.slot, event.version>>
Members(seq) == {seq[i]: i \in DOMAIN seq}
Pending(state) == state.phase \in {"offered", "admitted"}

(* Reduce accepts a completion only for its pending occurrence. *)
Reduce(state, event) ==
  LET old == state[event.slot]
  IN CASE event.kind = "request" ->
            [state EXCEPT ![event.slot] = [version |-> event.version, phase |-> "offered", value |-> 0]]
       [] event.kind = "admit" /\ old.version = event.version /\ old.phase = "offered" ->
            [state EXCEPT ![event.slot].phase = "admitted"]
       [] event.kind = "finish" /\ old.version = event.version /\ Pending(old) ->
            [state EXCEPT ![event.slot] = [version |-> old.version, phase |-> "finished", value |-> event.value]]
       [] OTHER -> state

(* ReplaySlot derives a slot from its latest request and matching suffix without using Reduce. *)
ReplaySlot(history, slot) ==
  LET requests == SelectSeq(history, LAMBDA e: e.kind = "request" /\ e.slot = slot)
  IN IF Len(requests) = 0 THEN Idle
     ELSE LET version == requests[Len(requests)].version
              suffix == SelectSeq(history, LAMBDA e: e.slot = slot /\ e.version = version)
              finished == SelectSeq(suffix, LAMBDA e: e.kind = "finish")
              admitted == SelectSeq(suffix, LAMBDA e: e.kind = "admit")
          IN [version |-> version,
              phase |-> IF Len(finished) > 0 THEN "finished" ELSE IF Len(admitted) > 0 THEN "admitted" ELSE "offered",
              value |-> IF Len(finished) > 0 THEN finished[1].value ELSE 0]
Replay(history) == [slot \in Slots |-> ReplaySlot(history, slot)]

VARIABLES logs, live, handles, drafts, selected, flights, traces, previews, mode
vars == <<logs, live, handles, drafts, selected, flights, traces, previews, mode>>
View(side) == IF side = Left THEN live ELSE Replay(logs[side])
Keys(side) == {Key(e): e \in Members(logs[side])}
Cleanup(side) == {slot \in Slots: Pending(View(side)[slot]) /\ ~(Fault = "cleanup" /\ side = Left)}
Offers(side) == {slot \in Slots: Pending(View(side)[slot])}
Output(side) == [view |-> View(side), proposals |-> Offers(side), cancel |-> Cleanup(side)]

Init == /\ logs = [side \in Sides |-> <<>>]
        /\ live = Empty
        /\ handles = [side \in Sides |-> None]
        /\ drafts = [side \in Sides |-> None]
        /\ selected = [side \in Sides |-> None]
        /\ flights = [side \in Sides |-> {}]
        /\ traces = [side \in Sides |-> <<>>]
        /\ previews = [side \in Sides |-> None]
        /\ mode = "allow"

AppendEvents(events) ==
  /\ logs' = [side \in Sides |-> Append(logs[side], events[side])]
  /\ live' = IF Fault = "stale" /\ events[Left].kind = "finish" /\ Pending(live[events[Left].slot])
               THEN Reduce(live, [events[Left] EXCEPT !.version = live[events[Left].slot].version])
               ELSE Reduce(live, events[Left])

Request(slot) ==
  /\ \A side \in Sides: Len(logs[side]) < MaxEvents /\ View(side)[slot].version < Versions
  /\ AppendEvents([side \in Sides |-> Event("request", slot, View(side)[slot].version + 1, 0)])
  /\ UNCHANGED <<handles, drafts, selected, flights, traces, previews, mode>>

(* Capture retains a snapshot-bound response and an admission cursor across later commits. *)
Capture(slot) ==
  /\ \A side \in Sides: slot \in Offers(side)
  /\ handles' = [side \in Sides |-> [slot |-> slot, snapshot |-> View(side), head |-> Len(logs[side])]]
  /\ previews' = [side \in Sides |-> None]
  /\ UNCHANGED <<logs, live, drafts, selected, flights, traces, mode>>

Respond(value) ==
  /\ \A side \in Sides: handles[side] # None
  /\ drafts' = [side \in Sides |-> LET h == handles[side]
                  IN Event("finish", h.slot, h.snapshot[h.slot].version,
                           IF Fault = "response" /\ side = Left THEN 1 - value ELSE value)]
  /\ live' = IF Fault = "early" THEN Reduce(live, drafts'[Left]) ELSE live
  /\ UNCHANGED <<logs, handles, selected, flights, traces, previews, mode>>

(* Preview reserves the retained snapshot's admission once, without publishing or committing it. *)
Preview ==
  /\ \A side \in Sides: handles[side] # None
  /\ previews' = [side \in Sides |-> LET h == handles[side]
                   IN IF previews[side] # None \/ h.snapshot[h.slot].phase # "offered" THEN Rejected
                      ELSE Reduce(h.snapshot, Event("admit", h.slot, h.snapshot[h.slot].version, 0))]
  /\ UNCHANGED <<logs, live, handles, drafts, selected, flights, traces, mode>>

Cancel(slot) ==
  /\ \A side \in Sides: slot \in Cleanup(side)
  /\ drafts' = [side \in Sides |-> Event("finish", slot, View(side)[slot].version, 2)]
  /\ UNCHANGED <<logs, live, handles, selected, flights, traces, previews, mode>>

(* SelectWork applies the same policy program to each child's own output. *)
SelectWork(slot) ==
  /\ \A side \in Sides: slot \in Offers(side)
  /\ selected' = [side \in Sides |->
       IF mode = "wait" THEN None
       ELSE Event(IF mode = "reject" THEN "finish" ELSE IF View(side)[slot].phase = "offered" THEN "admit" ELSE "run",
                  slot, View(side)[slot].version, IF mode = "reject" THEN 2 ELSE 0)]
  /\ UNCHANGED <<logs, live, handles, drafts, flights, traces, previews, mode>>
Publish == /\ \A side \in Sides: drafts[side] # None
           /\ selected' = drafts
           /\ UNCHANGED <<logs, live, handles, drafts, flights, traces, previews, mode>>
Withhold == /\ selected' = [side \in Sides |-> None]
            /\ UNCHANGED <<logs, live, handles, drafts, flights, traces, previews, mode>>
Policy(nextMode) == /\ mode' = nextMode
                    /\ UNCHANGED <<logs, live, handles, drafts, selected, flights, traces, previews>>

Commit ==
  /\ \A side \in Sides:
       /\ selected[side] # None
       /\ selected[side].kind \in {"admit", "finish"}
       /\ Len(logs[side]) < MaxEvents
       /\ Fault = "duplicate" \/ Key(selected[side]) \notin Keys(side)
  /\ AppendEvents(selected)
  /\ UNCHANGED <<handles, drafts, selected, flights, traces, previews, mode>>

(* Execute exposes a matched external action; returning its result is a separate step. *)
Execute ==
  /\ \A side \in Sides:
       /\ selected[side] # None
       /\ selected[side].kind = "run"
       /\ View(side)[selected[side].slot].version = selected[side].version
       /\ View(side)[selected[side].slot].phase = "admitted"
       /\ selected[side] \notin flights[side]
       /\ Len(traces[side]) < MaxEffects
  /\ flights' = [side \in Sides |-> flights[side] \cup {selected[side]}]
  /\ traces' = [side \in Sides |-> Append(traces[side], selected[side])]
  /\ UNCHANGED <<logs, live, handles, drafts, selected, previews, mode>>
Return(work, value) ==
  /\ \A side \in Sides: work \in flights[side]
  /\ drafts' = [side \in Sides |-> Event("finish", work.slot, work.version, value)]
  /\ flights' = [side \in Sides |-> flights[side] \ {work}]
  /\ UNCHANGED <<logs, live, handles, selected, traces, previews, mode>>

(* Restart discards process-local capabilities and reconstructs state from each durable log. *)
Restart == /\ live' = Replay(logs[Left])
           /\ handles' = [side \in Sides |-> None]
           /\ drafts' = [side \in Sides |-> None]
           /\ selected' = [side \in Sides |-> None]
           /\ flights' = [side \in Sides |-> {}]
           /\ previews' = [side \in Sides |-> None]
           /\ UNCHANGED <<logs, traces, mode>>
Next == \/ \E slot \in Slots: Request(slot) \/ Capture(slot) \/ Cancel(slot) \/ SelectWork(slot)
        \/ \E value \in 0..1: Respond(value)
        \/ \E work \in flights[Left], value \in 0..1: Return(work, value)
        \/ \E nextMode \in Modes: Policy(nextMode)
        \/ Preview \/ Publish \/ Withhold \/ Commit \/ Execute \/ Restart
Spec == Init /\ [][Next]_vars

StateSpace == [Slots -> [version: 0..Versions, phase: {"idle", "offered", "admitted", "finished"}, value: 0..2]]
WorkSpace == [kind: {"request", "admit", "finish", "run"}, slot: Slots, version: 1..Versions, value: 0..2]
HandleSpace == [slot: Slots, snapshot: StateSpace, head: 0..MaxEvents]
TypeOK == /\ mode \in Modes
          /\ live \in StateSpace
          /\ \A side \in Sides:
               /\ logs[side] \in Seq([kind: {"request", "admit", "finish"}, slot: Slots, version: 1..Versions, value: 0..2])
               /\ Len(logs[side]) <= MaxEvents
               /\ handles[side] \in HandleSpace \cup {None}
               /\ drafts[side] \in WorkSpace \cup {None}
               /\ selected[side] \in WorkSpace \cup {None}
               /\ flights[side] \subseteq WorkSpace
               /\ traces[side] \in Seq(WorkSpace)
               /\ Len(traces[side]) <= MaxEffects
               /\ previews[side] \in StateSpace \cup {None, Rejected}
ReplayAgreement == live = Replay(logs[Left])
Substitution == /\ Output(Left) = Output(Right)
                /\ logs[Left] = logs[Right]
                /\ handles[Left] = handles[Right]
                /\ drafts[Left] = drafts[Right]
                /\ selected[Left] = selected[Right]
                /\ flights[Left] = flights[Right]
                /\ traces[Left] = traces[Right]
                /\ previews[Left] = previews[Right]
UniqueCommits == \A side \in Sides: Cardinality(Keys(side)) = Len(logs[side])
ExecutionAdmitted == \A side \in Sides: \A work \in Members(traces[side]):
  <<"admit", work.slot, work.version>> \in Keys(side)

=============================================================================
