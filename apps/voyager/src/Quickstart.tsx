import { Check, Copy } from "@phosphor-icons/react"
import { useEffect, useState, type ReactElement } from "react"

import { client } from "./client"
import { COPY_CONFIRM_MS, ICON_SIZE } from "./policy"

export interface QuickstartCommands {
  readonly cli: string
  readonly curl: string
}

// quickstartCommands returns commands addressed to the server this tab is reading.
export const quickstartCommands = (baseUrl: string): QuickstartCommands => ({
  cli: `tdg run "Tell me what you can do" --url ${baseUrl}`,
  curl: `curl -X POST ${baseUrl}/v1/actors/agent/threads/hello/events \\\n+  -H 'content-type: application/json' \\\n+  -d '{"id":"hello-1","type":"MessageReceived","text":"Tell me what you can do"}'`
})

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

const CommandCard = ({ command, label }: { readonly command: string; readonly label: string }): ReactElement => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPY_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <section className="quickstart-card">
      <div className="quickstart-card-head">
        <span className="mono quickstart-label">{label}</span>
        <button
          type="button"
          className={`quickstart-copy${copied ? " quickstart-copy-done" : ""}`}
          aria-label={`Copy ${label} quickstart`}
          onClick={() => {
            void copyText(command).then((ok) => {
              if (ok) setCopied(true)
            })
          }}
        >
          {copied ? <Check size={ICON_SIZE} weight="light" aria-hidden="true" /> : <Copy size={ICON_SIZE} weight="light" aria-hidden="true" />}
          <span>{copied ? "copied" : "copy"}</span>
        </button>
      </div>
      <pre className="quickstart-code"><code>{command}</code></pre>
    </section>
  )
}

export const Quickstart = (): ReactElement => {
  const commands = quickstartCommands(client.baseUrl)
  return (
    <div className="quickstart-empty">
      <div className="quickstart">
        <div className="quickstart-intro">
          <h1>Start your first run</h1>
          <p>Agent traces will appear here once a run starts.</p>
        </div>
        <div className="quickstart-grid">
          <CommandCard label="CLI" command={commands.cli} />
          <CommandCard label="curl" command={commands.curl} />
        </div>
      </div>
    </div>
  )
}
