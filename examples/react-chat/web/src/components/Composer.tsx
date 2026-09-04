import { Button } from "@base-ui/react/button"
import { Input } from "@base-ui/react/input"
import { ArrowUp, CircleNotch } from "@phosphor-icons/react"
import { useState, type FormEvent, type ReactElement } from "react"

export const Composer = ({ id, onSend, pending, placeholder }: {
  readonly id: string
  readonly onSend: (text: string) => void
  readonly pending: boolean
  readonly placeholder: string
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
      <Button type="submit" disabled={pending || draft.trim().length === 0} focusableWhenDisabled>
        {pending ? <CircleNotch className="spin" /> : <ArrowUp />}
        <span className="sr-only">Send message</span>
      </Button>
    </form>
  )
}
