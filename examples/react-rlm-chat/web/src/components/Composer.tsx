import { Button } from "@base-ui/react/button"
import { Input } from "@base-ui/react/input"
import { ArrowUp, CircleNotch, Paperclip, Square, X } from "@phosphor-icons/react"
import { useRef, useState, type FormEvent, type ReactElement } from "react"
import type { UploadPolicy } from "../attachments"

export const Composer = ({ cancelling = false, id, onCancel, onSend, pending, placeholder, running = false, uploadPolicy }: {
  readonly cancelling?: boolean
  readonly id: string
  readonly onCancel?: () => void
  readonly onSend: (text: string, files: ReadonlyArray<File>) => Promise<unknown>
  readonly uploadPolicy: UploadPolicy | undefined
  readonly pending: boolean
  readonly placeholder: string
  readonly running?: boolean
}): ReactElement => {
  const [draft, setDraft] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const picker = useRef<HTMLInputElement>(null)
  const busy = sending || pending

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = draft.trim()
    if ((text.length === 0 && files.length === 0) || busy || running) return
    setSending(true)
    setError(undefined)
    try {
      await onSend(text, files)
      setDraft("")
      setFiles([])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Message could not be sent")
    } finally {
      setSending(false)
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      {files.length === 0 ? null : <ul className="attachments composer-attachments" aria-label="Selected files">
        {files.map((file, index) => <li key={index}>
          <span>{file.name}</span>
          <Button type="button" className="attachment-remove" disabled={busy} aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter((_, i) => i !== index))}><X /></Button>
        </li>)}
      </ul>}
      <input ref={picker} type="file" className="sr-only" tabIndex={-1} multiple accept={uploadPolicy?.mediaTypes.join(",")} disabled={busy || uploadPolicy === undefined} onChange={event => {
        setFiles(current => [...current, ...Array.from(event.target.files ?? [])])
        event.target.value = ""
      }} />
      <Button type="button" className="attach-button" disabled={busy || uploadPolicy === undefined} aria-label="Attach images or PDFs" onClick={() => picker.current?.click()}><Paperclip /></Button>
      <label htmlFor={id}>Message</label>
      <Input id={id} placeholder={placeholder} value={draft} onValueChange={setDraft} autoComplete="off" disabled={busy} />
      <Button
        type={running ? "button" : "submit"}
        disabled={running ? cancelling : busy || (draft.trim().length === 0 && files.length === 0)}
        focusableWhenDisabled
        onClick={running ? onCancel : undefined}
      >
        {cancelling || busy ? <CircleNotch className="spin" /> : running ? <Square weight="fill" /> : <ArrowUp />}
        <span className="sr-only">{running ? "Stop response" : "Send message"}</span>
      </Button>
      <span className="attachment-hint" role="status">{sending && files.length > 0 ? "Uploading files and sending…" : uploadPolicy === undefined ? "Attachments unavailable on this server" : `Images and PDFs, up to ${uploadPolicy.maxUploadBytes.toLocaleString()} bytes each`}</span>
      {error === undefined ? null : <p className="error composer-error" role="alert">{error}</p>}
    </form>
  )
}
