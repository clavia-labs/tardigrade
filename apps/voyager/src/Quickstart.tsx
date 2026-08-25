import { Check, Copy } from "@phosphor-icons/react"
import { useEffect, useState, type ReactElement } from "react"

import { COPY_CONFIRM_MS, ICON_SIZE } from "./policy"
import { client } from "./client"

// START_COMMAND invokes the current actor with the onboarding brief (Quickstart.test.ts).
export const START_COMMAND = "tdg call message '{\"text\":\"Read this repository and tell me what it does\"}'"

const shellWord = (value: string): string =>
  /^[A-Za-z0-9_./:-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`

// startCommand states the current server address in the copied invocation (Quickstart.test.ts).
export const startCommand = (baseUrl: string): string =>
  `${START_COMMAND} --url ${shellWord(baseUrl)}`

const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand("copy")
    area.remove()
    return copied
  }
}

const CommandCard = ({ command }: { readonly command: string }): ReactElement => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPY_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <section className="quickstart-command">
      <span className="mono quickstart-prompt" aria-hidden="true">$</span>
      <code className="quickstart-code">{command}</code>
      <button
        type="button"
        className={`quickstart-copy${copied ? " quickstart-copy-done" : ""}`}
        aria-label={copied ? "Command copied" : "Copy command"}
        title={copied ? "Copied" : "Copy command"}
        onClick={() => {
          void copyText(command).then((ok) => {
            if (ok) setCopied(true)
          })
        }}
      >
        {copied ? <Check size={ICON_SIZE} weight="light" aria-hidden="true" /> : <Copy size={ICON_SIZE} weight="light" aria-hidden="true" />}
      </button>
    </section>
  )
}

export const Quickstart = (): ReactElement => (
  <div className="quickstart-empty">
    <div className="quickstart">
      <div className="quickstart-intro">
        <h1>Start a thread</h1>
        <p>Run this command from another terminal.</p>
      </div>
      <CommandCard command={startCommand(client.baseUrl)} />
    </div>
  </div>
)
