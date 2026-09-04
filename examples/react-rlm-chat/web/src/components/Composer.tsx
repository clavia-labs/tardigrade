import { Button } from "@base-ui/react/button"
import { Input } from "@base-ui/react/input"
import { ArrowUp, CircleNotch, Square } from "@phosphor-icons/react"
import { useState, type FormEvent, type ReactElement } from "react"

export const Composer = ({ cancelling = false, id, onCancel, onSend, pending, placeholder, running = false }: {
  readonly cancelling?: boolean
  readonly id: string
  readonly onCancel?: () => void
  readonly onSend: (text: string) => void
  readonly pending: boolean
  readonly placeholder: string
  readonly running?: boolean
}): ReactElement => {
  const [draft, setDraft] = useState("")

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = draft.trim()
    if (text.length === 0 || pending) return
    setDraft("")
    onSend(text)
  }

  return (
    <form className="composer" onSubmit={submit}>
      <label htmlFor={id}>Message</label>
      <Input id={id} placeholder={placeholder} value={draft} onValueChange={setDraft} autoComplete="off" />
      <Button
        type={running ? "button" : "submit"}
        disabled={running ? cancelling : pending || draft.trim().length === 0}
        focusableWhenDisabled
        onClick={running ? onCancel : undefined}
      >
        {cancelling || pending ? <CircleNotch className="spin" /> : running ? <Square weight="fill" /> : <ArrowUp />}
        <span className="sr-only">{running ? "Stop response" : "Send message"}</span>
      </Button>
    </form>
  )
}
