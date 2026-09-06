---------------------------- MODULE Component ----------------------------
(* A component derives a view and transitions from one log. The infer root
   interprets its composed child view as tool bindings. A binding
   pairs a visible tool with its handler, but pairing at one log does not by
   itself keep the tool routable after ToolCalled extends that log.

   OFFEREDISROUTABLE states the required prefix rule. Offer records the tools
   derived before ModelCalled. Call may select only one of those tools. Route
   consults the same prefix, so later events cannot revoke the handler for a
   pending call.

   CURRENTVIEWROUTABLE is checked and expected to fail in
   ComponentCurrent.cfg. The miniature tool disappears once a call exists.
   Routing against the current log therefore loses a tool that the model was
   allowed to call. The counterexample is offer, call. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

Tools == {"once"}
Events == {"model", "call", "return"}

ToolsAt(history) ==
  IF \E i \in DOMAIN history: history[i] = "call" THEN {} ELSE Tools

VARIABLES log, offered, offerAt, pending, called

vars == <<log, offered, offerAt, pending, called>>

TypeOK ==
  /\ log \in Seq(Events)
  /\ offered \subseteq Tools
  /\ offerAt \in 0..Len(log)
  /\ pending \in BOOLEAN
  /\ called \in Tools \cup {"none"}

Init ==
  /\ log = <<>>
  /\ offered = {}
  /\ offerAt = 0
  /\ pending = FALSE
  /\ called = "none"

(* Offer appends ModelCalled after deriving the view from the prior
   prefix, the order inferReactorFor commits in runtime/infer.ts. *)
Offer ==
  /\ offerAt = 0
  /\ offered' = ToolsAt(log)
  /\ log' = Append(log, "model")
  /\ offerAt' = Len(log) + 1
  /\ UNCHANGED <<pending, called>>

Call(tool) ==
  /\ offerAt > 0
  /\ ~pending
  /\ called = "none"
  /\ tool \in offered
  /\ log' = Append(log, "call")
  /\ pending' = TRUE
  /\ called' = tool
  /\ UNCHANGED <<offered, offerAt>>

(* Route derives bindings from the prefix before ModelCalled while passing the
   current log to the selected handler (runtime/agent.ts, offerLogFor). *)
Route ==
  /\ pending
  /\ called \in ToolsAt(SubSeq(log, 1, offerAt - 1))
  /\ log' = Append(log, "return")
  /\ pending' = FALSE
  /\ UNCHANGED <<offered, offerAt, called>>

Next ==
  \/ Offer
  \/ \E tool \in Tools: Call(tool)
  \/ Route

Spec == Init /\ [][Next]_vars

OfferedIsRoutable ==
  pending => called \in ToolsAt(SubSeq(log, 1, offerAt - 1))

CurrentViewRoutable ==
  pending => called \in ToolsAt(log)

=============================================================================
