---------------------------- MODULE Totality ----------------------------
(* The second doctrine theorem: the rulebook must cover its alphabet, and
   no room may swallow an event into the void.

   A fold never crashes on a missing rule; it skips. Silence is ambiguous:
   an intended "not my business" or a forgotten answer, and the fold
   cannot tell them apart. The 2026-08-15 wedge was the second kind:
   (parked, dispatch) was reachable and unwritten, and a lane froze with
   an execution owed.

   THE LAW (ruled 2026-08-16): every reachable (room, event) pair is
   classified. A pair is either a DOOR (it moves the walker or writes the
   pad) or a SIGNED SKIP (a statement that the event is meaningless in
   that room). "Meaningless" is strict: an event that records owed work
   (a dispatch, a reply) is never meaningless anywhere; a busy room
   queues it on the pad and its exit doors drain the queue.

   Two walkers over the same appends:
   CUR: today's rulebook (src/code/execute.ts). Expected: NoVoidCur FAILS
        (dispatch, reply, park: parked over a live unharvested reply,
        three events, the run-fcb28550-3be livelock's shape).
   FIX: the ruled rulebook. Dispatch queues (pad q), replies note owed
        work (pad owed), the park door bounces to executing while owed,
        the settle door drains the queue, start and settle are doors out
        of parked. Expected: NoVoidFix and TotalFix hold.

   The history model is ADVERSARIAL: any event, any time. Zombies are
   real appenders (run-fcb28550-3be's three bodies appended for 200ms
   after their attempts closed); a rulebook total only under polite
   histories is total until the first zombie. *)

EXTENDS Naturals, FiniteSets, TLC

Events == {"dispatch", "start", "park", "reply", "harvest", "settle"}
Rooms  == {"idle", "executing", "parked"}

QMax == 2

(* ----- CUR: today's rulebook, pad-less ----- *)

StepCur(room, e) ==
  CASE room = "idle"      /\ e = "dispatch" -> "executing"
    [] room = "executing" /\ e = "settle"   -> "idle"
    [] room = "executing" /\ e = "park"     -> "parked"
    [] room = "parked"    /\ e = "reply"    -> "executing"
    [] OTHER                                -> room

(* ----- FIX: the ruled rulebook. The walker is <<room, q, owed>>: q
   counts queued dispatches beyond the one being served; owed marks a
   reply that is home but not yet harvested. ----- *)

StepFix(s, e) ==
  LET room == s[1] q == s[2] owed == s[3] IN
  CASE e = "dispatch" ->
         IF room = "idle" THEN <<"executing", q, owed>>
         ELSE <<room, IF q < QMax THEN q + 1 ELSE q, owed>>       \* door: queue
    [] e = "start" ->
         IF room = "parked" THEN <<"executing", q, owed>>          \* door: durable resume
         ELSE s                                                    \* skip: own footprint
    [] e = "reply" ->
         IF room = "parked" THEN <<"executing", q, TRUE>>          \* door: wake
         ELSE IF room = "executing" THEN <<room, q, TRUE>>         \* door: note owed
         ELSE s                                                    \* skip: no open call
    [] e = "harvest" ->
         <<room, q, FALSE>>                                        \* pad: answer recorded
    [] e = "park" ->
         IF room = "executing"
           THEN IF owed THEN <<"executing", q, owed>>              \* door: bounce, wake owed
                        ELSE <<"parked", q, owed>>                 \* door: sleep
         ELSE s                                                    \* skip: no attempt open
    [] e = "settle" ->
         IF room = "executing"
           THEN IF q > 0 THEN <<"executing", q - 1, owed>>         \* door: drain the queue
                         ELSE <<"idle", q, owed>>                  \* door: home
         ELSE IF room = "parked" THEN <<"idle", q, owed>>          \* door: belt-and-braces
         ELSE s                                                    \* skip: nothing open
    [] OTHER -> s

(* The classification, as data: all 18 pairs, each a door or a signed
   skip. TotalFix fails if an event is ever added without a row here. *)
DoorsFix == {
  <<"idle",      "dispatch">>, <<"executing", "dispatch">>, <<"parked", "dispatch">>,
  <<"parked",    "start">>,
  <<"executing", "reply">>,    <<"parked",    "reply">>,
  <<"idle",      "harvest">>,  <<"executing", "harvest">>,  <<"parked", "harvest">>,
  <<"executing", "park">>,
  <<"executing", "settle">>,   <<"parked",    "settle">>
}
SkipsFix == {
  <<"idle",      "start">>,    <<"executing", "start">>,
  <<"idle",      "reply">>,
  <<"idle",      "park">>,     <<"parked",    "park">>,
  <<"idle",      "settle">>
}

-----------------------------------------------------------------------
VARIABLES curRoom, curOwed, fix, pairs

vars == <<curRoom, curOwed, fix, pairs>>

Init ==
  /\ curRoom = "idle"
  /\ curOwed = FALSE
  /\ fix = <<"idle", 0, FALSE>>
  /\ pairs = {}

(* curOwed mirrors the FIX pad against the CUR walker: a reply seen in
   any room marks work home; a harvest clears it. CUR's rulebook never
   consults it, which is the point: the invariant can. *)
Append1(e) ==
  /\ pairs' = pairs \cup {<<fix[1], e>>}
  /\ curRoom' = StepCur(curRoom, e)
  /\ curOwed' = IF e = "reply" THEN TRUE ELSE IF e = "harvest" THEN FALSE ELSE curOwed
  /\ fix' = StepFix(fix, e)

Next == \E e \in Events: Append1(e)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------
(* No void: a walker never rests over a reply that is home unharvested. *)
NoVoidCur == curRoom = "parked" => ~curOwed
NoVoidFix == fix[1] = "parked" => ~fix[3]

(* The coverage theorem: every reachable pair is classified. *)
TotalFix == pairs \subseteq (DoorsFix \cup SkipsFix)

=======================================================================
