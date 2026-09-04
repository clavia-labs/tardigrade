import { Button } from "@base-ui/react/button"
import { ArrowLeft, CircleNotch, X } from "@phosphor-icons/react"
import type { ReactElement } from "react"
import type { EventRow } from "@clavia/tardigrade-client"

import { Composer } from "./Composer"
import { Transcript } from "./Transcript"

export const SideThread = ({ cancelling, error, loading, onCancel, onClose, onOpenThread, onSend, pending, rows, running, streamingText }: {
  readonly cancelling: boolean
  readonly error: unknown
  readonly loading: boolean
  readonly onCancel: () => void
  readonly onClose: () => void
  readonly onOpenThread: (id: string) => void
  readonly onSend: (text: string) => void
  readonly pending: boolean
  readonly rows: ReadonlyArray<EventRow>
  readonly running: boolean
  readonly streamingText: string
}): ReactElement => {
  const terminal = rows.findLast(({ event }) =>
    event.type === "TurnCompleted" || event.type === "TurnFailed" || event.type === "TurnCancelled")
  const failed = terminal?.event.type === "TurnFailed"

  return <aside className="side-thread" aria-label="Subagent thread">
    <header className="side-head">
      <Button className="icon-button side-back-button" onClick={onClose} aria-label="Back to parent thread">
        <ArrowLeft />
      </Button>
      <div className="side-title">
        <strong>Subagent</strong>
        {running ? (
          <CircleNotch className="spin side-status-spinner" aria-label="Subagent is running" />
        ) : failed ? <span>failed</span> : null}
      </div>
      <Button className="icon-button side-close-button" onClick={onClose} aria-label="Close subagent thread">
        <X />
      </Button>
    </header>
    <Transcript
      empty={loading ? "Loading thread…" : "No messages in this thread."}
      onOpenThread={onOpenThread}
      rows={rows}
      streamingText={streamingText}
    />
    <Composer
      cancelling={cancelling}
      id="child-message"
      onCancel={onCancel}
      onSend={onSend}
      pending={pending}
      placeholder="Message this subagent"
      running={running}
    />
    {error ? <p className="error side-error">{String(error)}</p> : null}
  </aside>
}
