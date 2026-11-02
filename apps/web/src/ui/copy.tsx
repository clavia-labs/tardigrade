import { useCallback, useEffect, useState, type ReactElement } from "react"

export const CopyIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="8" width="11" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2" />
  </svg>
)

export const CheckIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter" strokeWidth="1.8" d="m5 12.5 4.2 4.2L19 7" />
  </svg>
)

export const useCopy = (resetAfter = 1800): readonly [boolean, (value: string) => Promise<void>] => {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const reset = window.setTimeout(() => setCopied(false), resetAfter)
    return () => window.clearTimeout(reset)
  }, [copied, resetAfter])
  const copy = useCallback(async (value: string): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
  }, [])
  return [copied, copy]
}
