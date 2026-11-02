import { useState, type ReactElement, type ReactNode } from "react"
import { DropdownSelect } from "../../ui/DropdownSelect"

export interface CounterEvent { readonly type: "Incremented" | "Decremented" }

const Node = ({ label, children, className = "", type }: { readonly label: string; readonly children: ReactNode; readonly className?: string; readonly type?: string }): ReactElement => <div className={`atom-diagram-node ${className}`}>
  <span className="atom-diagram-label">{label}</span>
  <div className="atom-diagram-box">{children}</div>
  {type && <span className="atom-diagram-type">{type}</span>}
</div>

const Arrow = ({ label }: { readonly label: string }): ReactElement => <div className="atom-diagram-arrow" aria-hidden="true">
  {label && <span>{label}</span>}
  <svg viewBox="0 0 80 24" fill="none"><path d="M0 12H77M69 4L77 12L69 20" /></svg>
</div>

const EventLogNode = ({ events }: { readonly events: readonly { readonly type: string; readonly id?: string; readonly text?: string }[] }): ReactElement => {
  const latest = events.slice(-3)
  return <Node label="Event log" className="atom-diagram-log">
    <table aria-label="Event log"><tbody>
      {Array.from({ length: 3 }, (_, index) => {
        const event = latest[index]
        return <tr data-latest={Boolean(event) && index === latest.length - 1} key={event ? events.length - latest.length + index : `empty-${index}`}><td>{event ? String(events.length - latest.length + index + 1).padStart(3, "0") : "\u00a0"}</td><td>{event?.type ?? "\u00a0"}{event?.id && <small>id: {event.id}</small>}{event?.text && <small title={event.text}>{event.text}</small>}</td></tr>
      })}
    </tbody></table>
  </Node>
}

const ConsoleNode = ({ notifications, className = "" }: { readonly notifications: readonly number[]; readonly className?: string }): ReactElement =>
  <Node label="Console" className={`atom-diagram-console ${className}`}><div>{notifications.length ? notifications.slice(-3).map((value, index, lines) => <div data-latest={index === lines.length - 1} key={notifications.length - lines.length + index}>{value} is even</div>) : <span>No output</span>}</div></Node>

export const AtomPlaygroundDiagram = ({ events, kind, active, animate, showReducer = false, showConsole = false }: {
  readonly events: readonly CounterEvent[]
  readonly kind: "state" | "effect" | "methods"
  readonly active: boolean
  readonly animate: boolean
  readonly showReducer?: boolean
  readonly showConsole?: boolean
}): ReactElement => {
  let count = 0
  const notifications: number[] = []
  events.forEach(event => {
    count = event.type === "Decremented" ? count - 1 : count + 1
    if (count > 0 && count % 2 === 0) notifications.push(count)
  })
  const latest = events.slice(-3)
  const previousCount = latest.length ? count - (latest.at(-1)!.type === "Incremented" ? 1 : -1) : 0
  const ready = count > 0 && count % 2 === 0
  return <div className="atom-playground-diagram" data-kind={kind} data-reducer={showReducer} data-console={showConsole} data-ready={ready} data-pulse={active && animate}>
    <div className="atom-diagram-viewport">
      <div className="atom-diagram-scene">
        {kind !== "effect" && <>
          <EventLogNode events={events} />
          <Arrow label={showReducer ? "" : "reduce"} />
          {showReducer && <>
            <Node label="reduce" className="atom-diagram-reducer"><div key={events.length}>
              <div><span>current_count</span><output>{previousCount}</output></div>
              <div><span>event</span><output>{latest.at(-1)?.type ?? "None"}</output></div>
            </div></Node>
            <Arrow label="" />
          </>}
        </>}
        <Node label="count" type="Durable atom" className="atom-diagram-count"><output key={events.length}>{count}</output></Node>
        {kind !== "state" && <>
          <Arrow label="state" />
          <Node label="notify" type="Effect atom" className="atom-diagram-notify"><span>{ready ? "ready" : "idle"}</span></Node>
          {kind === "methods" && <><Arrow label="effect" /><ConsoleNode notifications={notifications} className="atom-diagram-method-console" /></>}
          {kind === "effect" && <><Arrow label="proposes" />
          <Node label="Action proposal" className="atom-diagram-proposal"><span>{ready ? `notify({ input: ${count} })` : "No action"}</span></Node>
          {showConsole && <><Arrow label="runs" /><ConsoleNode notifications={notifications} /></>}</>}
        </>}
        {kind === "methods" && <>
          <div className="atom-diagram-boundary" aria-hidden="true"><span>Pure</span><span>Effectful</span></div>
          <div className="atom-diagram-node atom-diagram-world"><div className="atom-diagram-box">World</div></div>
          <div key={events.length} className="atom-diagram-return" aria-hidden="true"><svg viewBox="0 0 648 300" fill="none"><path d="M548 250H90Q80 250 80 240V182M74 190L80 182L86 190" /></svg><span>method</span></div>
        </>}
      </div>
    </div>
    <output className="playground-status" aria-live="polite">count: {count}{kind === "methods" && notifications.length ? `; last notification: ${notifications.at(-1)} is even` : ""}</output>
  </div>
}

const durableAtomExample: readonly CounterEvent[] = [{ type: "Incremented" }, { type: "Incremented" }, { type: "Decremented" }]

export const DurableAtomDiagram = (): ReactElement => {
  const [events, setEvents] = useState<readonly CounterEvent[]>(durableAtomExample)
  const [animate, setAnimate] = useState(false)
  const append = (type: CounterEvent["type"], pointer: boolean) => {
    setAnimate(pointer)
    setEvents(events => [...events, { type }])
  }
  return <figure className="durable-atom-diagram" aria-label="Interactive durable counter derived from its event log.">
    <div className="diagram-playground-controls">
      <button type="button" onClick={event => append("Incremented", event.detail !== 0)}>Increment</button>
      <button type="button" onClick={event => append("Decremented", event.detail !== 0)}>Decrement</button>
    </div>
    <AtomPlaygroundDiagram events={events} kind="state" active animate={animate} showReducer />
  </figure>
}

export const EffectAtomDiagram = (): ReactElement => {
  const [events, setEvents] = useState<readonly CounterEvent[]>(durableAtomExample)
  const [animate, setAnimate] = useState(false)
  const append = (type: CounterEvent["type"], pointer: boolean) => {
    setAnimate(pointer)
    setEvents(events => [...events, { type }])
  }
  return <figure className="durable-atom-diagram" aria-label="Interactive effect atom. It proposes a notify action whenever the count is even.">
    <div className="diagram-playground-controls">
      <button type="button" onClick={event => append("Incremented", event.detail !== 0)}>Increment</button>
      <button type="button" onClick={event => append("Decremented", event.detail !== 0)}>Decrement</button>
    </div>
    <AtomPlaygroundDiagram events={events} kind="effect" active animate={animate} showConsole />
  </figure>
}

const familyMembers = ["rick", "morty"] as const
type FamilyMember = typeof familyMembers[number]
type FamilyCounterEvent = CounterEvent & { readonly id: FamilyMember }
const familyExample: readonly FamilyCounterEvent[] = [{ type: "Incremented", id: "rick" }, { type: "Incremented", id: "rick" }, { type: "Incremented", id: "morty" }]

export const DurableAtomFamilyDiagram = (): ReactElement => {
  const [events, setEvents] = useState<readonly FamilyCounterEvent[]>(familyExample)
  const [member, setMember] = useState<FamilyMember>("rick")
  const [animate, setAnimate] = useState(false)
  const counts = { rick: 0, morty: 0 }
  events.forEach(event => { counts[event.id] += event.type === "Incremented" ? 1 : -1 })
  const latest = events.at(-1)!
  const append = (type: CounterEvent["type"], pointer: boolean) => {
    setAnimate(pointer)
    setEvents(events => [...events, { type, id: member }])
  }
  return <figure className="durable-atom-diagram atom-family-diagram" aria-label="Interactive counter family. Each event updates only the counter matching its id.">
    <div className="diagram-playground-controls">
      <DropdownSelect label="Counter member" options={familyMembers} value={member} onChange={setMember} />
      <button type="button" onClick={event => append("Incremented", event.detail !== 0)}>Increment</button>
      <button type="button" onClick={event => append("Decremented", event.detail !== 0)}>Decrement</button>
    </div>
    <div className="atom-playground-diagram" data-pulse={animate}>
      <div className="atom-diagram-viewport"><div className="atom-diagram-scene atom-family-scene">
        <EventLogNode events={events} />
        <Arrow label="" />
        <Node label="key" className="atom-family-key"><span>event.id</span><output key={events.length}>{latest.id}</output></Node>
        <svg className="atom-family-branches" viewBox="0 0 48 184" fill="none" aria-hidden="true"><path d="M0 92H12V32H46M38 24L46 32L38 40M12 92V152H46M38 144L46 152L38 160" /></svg>
        <div className="atom-family-members">
          {familyMembers.map(id => <div key={id} data-updated={id === latest.id}>
            <Node label={`counters("${id}")`} type="Durable atom" className="atom-diagram-count"><output key={events.filter(event => event.id === id).length}>{counts[id]}</output></Node>
          </div>)}
        </div>
      </div></div>
      <output className="playground-status" aria-live="polite">rick: {counts.rick}; morty: {counts.morty}</output>
    </div>
  </figure>
}

const messageExample = ["Rick: Ready for another adventure?", "Morty: Do I have a choice?", "Rick: Great, let's go."].map(text => ({ type: "MessageAdded", text }))

const messageSuggestions = [
  "Morty: Here we go again.",
  "Rick: Grab the portal remote, Morty.",
  "Morty: Is that planet supposed to be blinking?",
  "Rick: Every dimension has a different parking policy.",
  "Morty: I think the spaceship is judging us.",
  "Rick: Relax, the emergency button is only mostly broken.",
  "Morty: Can we try an adventure with fewer tentacles?",
  "Rick: That is a tomorrow-universe problem.",
] as const

export const DurableAtomLogDiagram = (): ReactElement => {
  const [events, setEvents] = useState(messageExample)
  const [text, setText] = useState<string>(messageSuggestions[0])
  const [animate, setAnimate] = useState(false)
  const pageRows = events.slice(-3)
  const from = events.length - pageRows.length
  return <figure className="durable-atom-diagram atom-log-diagram" aria-label="Interactive message log. Each MessageAdded event projects its text into an ordered row.">
    <form className="diagram-playground-controls" onSubmit={event => {
      event.preventDefault()
      if (!text.trim()) return
      setEvents(events => [...events, { type: "MessageAdded", text: text.trim() }])
      const suggestions = messageSuggestions.filter(suggestion => suggestion !== text.trim())
      setText(suggestions[Math.floor(Math.random() * suggestions.length)]!)
    }}>
      <input aria-label="Message text" placeholder="Write a message…" value={text} onChange={event => setText(event.target.value)} />
      <button type="submit" disabled={!text.trim()} onClick={event => setAnimate(event.detail !== 0)}>Add message</button>
    </form>
    <div className="atom-playground-diagram" data-pulse={animate}>
      <div className="atom-diagram-viewport"><div className="atom-diagram-scene atom-log-scene">
        <EventLogNode events={events} />
        <Arrow label="" />
        <Node label="project" className="atom-log-project"><span>event.text</span></Node>
        <Arrow label="" />
        <Node label="messages.range()" type="Durable atom log" className="atom-log-rows">
          <table aria-label="Projected message rows"><tbody>{Array.from({ length: 3 }, (_, index) => {
            const event = pageRows[index]
            const position = from + index
            return <tr key={position} data-latest={Boolean(event) && position === events.length - 1}><td>{event ? String(position + 1).padStart(3, "0") : "\u00a0"}</td><td title={event?.text}><span className="atom-log-row-text">{event?.text ?? "\u00a0"}</span></td></tr>
          })}</tbody></table>
        </Node>
      </div></div>
      <output className="playground-status" aria-live="polite">{events.length} messages; latest: {events.at(-1)!.text}</output>
    </div>
    <figcaption>Latest {pageRows.length} of {events.length} messages</figcaption>
  </figure>
}
