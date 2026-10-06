import { ArrowSquareOut, CaretDown, ChatCircleDots } from "@phosphor-icons/react"
import { useEffect, useRef, useState, type ReactElement } from "react"
import { siClaude, siOpenai } from "simple-icons/icons"

import { CheckIcon, CopyIcon, useCopy } from "./copy"

const CopyMarkdownButton = ({ markdown }: { readonly markdown: string }): ReactElement => {
  const [copied, copy] = useCopy()
  return (
    <button className="copy-markdown" type="button" aria-label={copied ? "Markdown copied" : "Copy page as Markdown"} onClick={() => void copy(markdown)}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? "Copied" : "Copy MD"}</span>
    </button>
  )
}

const BrandIcon = ({ path }: { readonly path: string }): ReactElement => (
  <svg className="ask-ai-provider-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={path} /></svg>
)

const assistantPrompt = (markdown: string, contentType: string): string => `Use the following Tardigrade ${contentType} as context. Help me understand or apply it.\n\n<content>\n${markdown}\n</content>`

const AskAiButton = ({ markdown, contentType }: { readonly markdown: string; readonly contentType: string }): ReactElement => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("pointerdown", closeOutside)
      document.removeEventListener("keydown", closeOnEscape)
    }
  }, [open])
  const openAssistant = (url: string): void => {
    void navigator.clipboard.writeText(assistantPrompt(markdown, contentType))
    window.open(url, "_blank", "noopener,noreferrer")
    setOpen(false)
  }
  return (
    <div className="ask-ai" ref={rootRef}>
      <button className="ask-ai-trigger" type="button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((current) => !current)}>
        <ChatCircleDots className="ask-ai-trigger-icon" aria-hidden="true" /><span>Ask</span><CaretDown className="ask-ai-trigger-caret" aria-hidden="true" />
      </button>
      {open ? (
        <div className="ask-ai-menu">
          <button type="button" onClick={() => openAssistant("https://chatgpt.com/")}><BrandIcon path={siOpenai.path} /><span><strong>ChatGPT</strong><small>Copy context and open</small></span><ArrowSquareOut aria-hidden="true" /></button>
          <button type="button" onClick={() => openAssistant("https://claude.ai/new")}><BrandIcon path={siClaude.path} /><span><strong>Claude</strong><small>Copy context and open</small></span><ArrowSquareOut aria-hidden="true" /></button>
        </div>
      ) : null}
    </div>
  )
}

export const PageActions = ({ markdown, contentType = "documentation" }: { readonly markdown: string; readonly contentType?: string }): ReactElement => (
  <div className="guide-heading-actions"><CopyMarkdownButton markdown={markdown} /><AskAiButton markdown={markdown} contentType={contentType} /></div>
)
