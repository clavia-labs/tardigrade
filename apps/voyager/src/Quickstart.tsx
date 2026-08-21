import { Check, Copy } from "@phosphor-icons/react"
import { useEffect, useState, type ReactElement } from "react"

import { COPY_CONFIRM_MS, ICON_SIZE } from "./policy"

// QUICKSTART_PROMPT gives a coding agent the repository and workflow entrypoint.
export const QUICKSTART_PROMPT =
  "Use https://github.com/clavia-labs/tardigrade and follow skills/tardigrade/SKILL.md to create, author, build, push, and run a local actor. Share its Voyager trace URL."

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

const PromptCard = (): ReactElement => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPY_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <section className="quickstart-card">
      <div className="quickstart-card-head">
        <span className="mono quickstart-label">Prompt</span>
        <button
          type="button"
          className={`quickstart-copy${copied ? " quickstart-copy-done" : ""}`}
          aria-label="Copy quickstart prompt"
          onClick={() => {
            void copyText(QUICKSTART_PROMPT).then((ok) => {
              if (ok) setCopied(true)
            })
          }}
        >
          {copied ? <Check size={ICON_SIZE} weight="light" aria-hidden="true" /> : <Copy size={ICON_SIZE} weight="light" aria-hidden="true" />}
          <span>{copied ? "copied" : "copy"}</span>
        </button>
      </div>
      <pre className="quickstart-code"><code>{QUICKSTART_PROMPT}</code></pre>
    </section>
  )
}

export const Quickstart = (): ReactElement => (
  <div className="quickstart-empty">
    <div className="quickstart">
      <div className="quickstart-intro">
        <h1>Create your first actor</h1>
        <p>Copy this prompt into your coding agent.</p>
      </div>
      <PromptCard />
    </div>
  </div>
)
