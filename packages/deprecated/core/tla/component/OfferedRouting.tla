------------------------- MODULE OfferedRouting -------------------------
(* OfferedRouting preserves a pending call's offered binding across later view changes (OfferedRouting.cfg). *)
EXTENDS Naturals, Sequences, FiniteSets, TLC

Tools == {"once"}
Events == {"model", "call", "return"}
ToolsAt(history) == IF \E i \in DOMAIN history: history[i] = "call" THEN {} ELSE Tools
VARIABLES log, offered, offerAt, pending, called
vars == <<log, offered, offerAt, pending, called>>
TypeOK == /\ log \in Seq(Events)
          /\ offered \subseteq Tools
          /\ offerAt \in 0..Len(log)
          /\ pending \in BOOLEAN
          /\ called \in Tools \cup {"none"}
Init == /\ log = <<>>
        /\ offered = {}
        /\ offerAt = 0
        /\ pending = FALSE
        /\ called = "none"

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
