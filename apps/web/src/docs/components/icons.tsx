import type { ReactElement } from "react"

export const BulbIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M8.5 15.5A7 7 0 1 1 15.5 15.5C14.6 16.2 14 17 14 18h-4c0-1-.6-1.8-1.5-2.5Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>
)

export const ChevronIcon = (): ReactElement => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6.5 8 3.5 3.5L13.5 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" /></svg>
)

export const InlineMine = (): ReactElement => (
  <svg className="docs-inline-mine" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect className="verification-tile" data-kind="unsafe" x="1" y="1" width="22" height="22" />
    <path className="verification-tile-light" d="M2 22V2h20l-3 3H5v14Z" />
    <path className="verification-tile-shadow" d="M2 22h20V2l-3 3v14H5Z" />
    <g className="verification-tile-mark" transform="translate(12 12) scale(.7)">
      <path d="M0-7v14M-7 0H7M-5-5 5 5M5-5-5 5" />
      <circle className="verification-mine" r="4.5" />
      <rect className="verification-mine-glint" x="-2" y="-2" width="2" height="2" />
    </g>
  </svg>
)
