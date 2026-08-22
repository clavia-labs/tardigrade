import { Check, Copy } from "@phosphor-icons/react"
import { useEffect, useState, type ReactElement } from "react"

import { COPY_CONFIRM_MS, ICON_SIZE } from "./policy"

// QUICKSTART_PROMPT gives a coding agent the repository and workflow entrypoint.
export const QUICKSTART_PROMPT =
  "Use https://github.com/clavia-labs/tardigrade and follow skills/tardigrade/SKILL.md to create, author, build, push, and run a local actor. Share its Voyager trace URL."

// MIGRATION_PROMPT gives a coding agent the migration guide, verification target, and report contract.
export const MIGRATION_PROMPT =
  "Read https://github.com/clavia-labs/tardigrade/blob/next/docs/how-to/migrate.md. Implement and verify an end-to-end migration of this project's existing agent harness to Tardigrade. Preserve its behavior while moving the loop, tools, state, API, client, history, and deployment configuration. Run the existing tests and the same representative task before and after. Share the Voyager trace URL, summarize the changes, and report before/after harness lines, dependencies, model tokens, cost, and latency, including percentage changes when both values exist. Mark unavailable metrics."

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

const PromptCard = ({ label, prompt }: { readonly label: string; readonly prompt: string }): ReactElement => {
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
          aria-label={`Copy ${label.toLowerCase()} prompt`}
          onClick={() => {
            void copyText(prompt).then((ok) => {
              if (ok) setCopied(true)
            })
          }}
        >
          {copied ? <Check size={ICON_SIZE} weight="light" aria-hidden="true" /> : <Copy size={ICON_SIZE} weight="light" aria-hidden="true" />}
          <span>{copied ? "copied" : "copy"}</span>
        </button>
      </div>
      <pre className="quickstart-code"><code>{prompt}</code></pre>
    </section>
  )
}

export const Quickstart = (): ReactElement => (
  <div className="quickstart-empty">
    <div className="quickstart">
      <div className="quickstart-intro">
        <h1>Create or migrate an actor</h1>
        <p>Copy the prompt that fits your project into your coding agent.</p>
      </div>
      <div className="quickstart-grid">
        <PromptCard label="New actor" prompt={QUICKSTART_PROMPT} />
        <PromptCard label="Existing agent" prompt={MIGRATION_PROMPT} />
      </div>
    </div>
  </div>
)
