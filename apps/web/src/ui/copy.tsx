import { useCallback, useEffect, useState, type ReactElement } from "react"

export const CopyIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.8" d="M9 8h9v11H9zM6 16H5V5h9v1" />
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
