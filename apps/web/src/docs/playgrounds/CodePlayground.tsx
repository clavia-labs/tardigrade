import { useId, useRef, useState, type ReactElement, type ReactNode } from "react"
import { CheckIcon, CopyIcon, useCopy } from "../../ui/copy"
import { LiquidTabs } from "../../ui/LiquidTabs"
import { AtomPlaygroundDiagram, type CounterEvent } from "./AtomPlaygroundDiagram"

const views = [{ value: "code", label: "Code" }, { value: "playground", label: "Playground" }] as const

export const CodePlayground = ({ children, kind = "state" }: { readonly children: ReactNode; readonly kind?: "state" | "effect" | "methods" }): ReactElement => {
  const id = useId()
  const [view, setView] = useState<"code" | "playground">("code")
  const [events, setEvents] = useState<readonly CounterEvent[]>([])
  const [animate, setAnimate] = useState(false)
  const [copied, copy] = useCopy()
  const code = useRef<HTMLDivElement>(null)
  const append = (type: CounterEvent["type"], pointer: boolean) => {
    setAnimate(pointer)
    setEvents(events => [...events, { type }])
  }
  return <div className="code-playground" data-kind={kind}>
    <div className="code-playground-toolbar">
      <span>TypeScript</span>
      <LiquidTabs id={id} options={views} value={view} onChange={setView} label="Example view" role="tablist" />
      <button className="code-playground-copy" type="button" aria-label={copied ? "Code copied" : "Copy code"} onClick={() => void copy(code.current?.querySelector("code")?.textContent ?? "")}>{copied ? <CheckIcon /> : <CopyIcon />}</button>
    </div>
    <div className="code-playground-panels">
      <div ref={code} id={`${id}-code-panel`} role="tabpanel" aria-labelledby={`${id}-code-tab`} aria-hidden={view !== "code"} inert={view !== "code"} data-active={view === "code"} className="code-playground-source">{children}</div>
      <div id={`${id}-playground-panel`} role="tabpanel" aria-labelledby={`${id}-playground-tab`} aria-hidden={view !== "playground"} inert={view !== "playground"} data-active={view === "playground"} className="code-playground-demo">
        <div className="diagram-playground-controls"><button type="button" onClick={event => append("Incremented", event.detail !== 0)}>Increment</button><button type="button" onClick={event => append("Decremented", event.detail !== 0)}>Decrement</button><small>In-memory preview</small></div>
        <AtomPlaygroundDiagram events={events} kind={kind} active={view === "playground"} animate={animate} />
        <p className="diagram-playground-hint">{kind !== "effect" ? `Showing the latest ${Math.min(events.length, 3)} of ${events.length} events.` : "Even counts propose a notification. Odd counts stay idle."}</p>
      </div>
    </div>
  </div>
}
