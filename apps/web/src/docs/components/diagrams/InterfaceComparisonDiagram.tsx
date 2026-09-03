import type { ReactElement } from "react"

const comparison = `USER INTERFACE                         AGENT HARNESS

      state                              event log
        │                                    │
        ▼                                    ▼
 component tree                       component tree
   ├─ header                            ├─ system
   ├─ content                           ├─ compaction
   └─ actions                           └─ tools
        │                                    │
        ▼                                    ▼
  UI + effects                       view + transitions`

export const InterfaceComparisonDiagram = (): ReactElement => (
  <div
    className="interface-comparison"
    role="img"
    aria-label="A user interface maps state through a component tree to UI and effects. An agent harness maps an event log through a component tree to a view and transitions."
  >
    <pre aria-hidden="true">{comparison}</pre>
  </div>
)
