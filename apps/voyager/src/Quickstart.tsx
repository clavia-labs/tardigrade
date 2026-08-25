import { ArrowUpRight, Check, Copy } from "@phosphor-icons/react"
import { useEffect, useState, type ReactElement } from "react"
import type { ActorMetadata } from "@clavia/tardigrade-client"

import { COPY_CONFIRM_MS, ICON_SIZE } from "./policy"
import { client, docsUrl } from "./client"

// START_COMMAND invokes the current actor with the onboarding brief (Quickstart.test.ts).
/** @internal */
export const START_COMMAND = "tdg call message '{\"text\":\"Read this repository and tell me what it does\"}'"

const shellWord = (value: string): string =>
  /^[A-Za-z0-9_./:-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`

const storageLabel = (location: string): string =>
  location === ":memory:" ? location : location.split(/[\\/]/).slice(-2).join("/")

// startCommand states the current server address in the copied invocation (Quickstart.test.ts).
/** @internal */
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

export const Quickstart = ({ actorMetadata }: { readonly actorMetadata: ActorMetadata | undefined }): ReactElement => (
  <div className="quickstart-empty">
    <div className="quickstart">
      <section className="quickstart-actor" aria-label="Actor context">
        <div className="quickstart-actor-fact">
          <span className="mono quickstart-actor-label">actor</span>
          <span className="mono quickstart-actor-value" title={actorMetadata?.name}>{actorMetadata?.name ?? "\u00a0"}</span>
        </div>
        <div className="quickstart-actor-fact">
          <span className="mono quickstart-actor-label">store</span>
          <span className="mono quickstart-actor-value" title={actorMetadata?.storage.location ?? actorMetadata?.storage.kind}>
            {actorMetadata === undefined
              ? "\u00a0"
              : actorMetadata.storage.location === undefined
              ? actorMetadata.storage.kind
              : storageLabel(actorMetadata.storage.location)}
          </span>
        </div>
        <div className="quickstart-actor-fact">
          <span className="mono quickstart-actor-label">address</span>
          <span className="mono quickstart-actor-value" title={client.baseUrl}>{client.baseUrl}</span>
        </div>
        <div className="quickstart-actor-fact">
          <span className="mono quickstart-actor-label">api</span>
          <a className="quickstart-api" href={docsUrl()} target="_blank" rel="noreferrer">
            <span>API reference</span>
            <ArrowUpRight size={ICON_SIZE} weight="light" aria-hidden="true" />
          </a>
        </div>
      </section>
      <div className="quickstart-divider" aria-hidden="true" />
      <div className="quickstart-action">
        <div className="quickstart-intro">
          <h1>Start a new thread</h1>
          <p>Run this command from another terminal.</p>
        </div>
        <CommandCard command={startCommand(client.baseUrl)} />
      </div>
    </div>
  </div>
)
