import { useLayoutEffect, useState, type ReactElement } from "react"

type Point = { readonly x: number; readonly y: number }

type FlowGeometry = {
  readonly componentLeft: Point
  readonly componentRight: Point
  readonly globe: Point
  readonly source: Point
  readonly target: Point | undefined
  readonly vertical: boolean
}

type FlowOverlayProps = {
  readonly selectedSequence: string
  readonly targetSequence: string | undefined
}

const centerY = (rect: DOMRect, parent: DOMRect): number => rect.top - parent.top + rect.height / 2
const centerX = (rect: DOMRect, parent: DOMRect): number => rect.left - parent.left + rect.width / 2

export const FlowOverlay = ({ selectedSequence, targetSequence }: FlowOverlayProps): ReactElement => {
  const [geometry, setGeometry] = useState<FlowGeometry | null>(null)

  useLayoutEffect(() => {
    const overlay = document.querySelector<SVGSVGElement>(".flow-overlay")
    const grid = overlay?.parentElement
    if (overlay == null || grid == null) return

    const measure = (): void => {
      const source = grid.querySelector<SVGGElement>(`[data-event-sequence="${selectedSequence}"]`)
      const target = targetSequence === undefined ? null : grid.querySelector<SVGGElement>(`[data-event-sequence="${targetSequence}"]`)
      const component = Array.from(grid.querySelectorAll<SVGRectElement>(".bridge-stamp .postal-stamp-fill"))
        .find((candidate) => candidate.getBoundingClientRect().width > 0)
      const globe = grid.querySelector<SVGCircleElement>(".globe-sphere")
      if (source === null || component === undefined || globe === null) return

      const gridRect = grid.getBoundingClientRect()
      const sourceRect = source.getBoundingClientRect()
      const componentRect = component.getBoundingClientRect()
      const globeRect = globe.getBoundingClientRect()
      const targetRect = target?.getBoundingClientRect()
      const vertical = window.matchMedia("(max-width: 1140px)").matches

      setGeometry({
        vertical,
        source: vertical
          ? { x: sourceRect.right - gridRect.left - 8, y: centerY(sourceRect, gridRect) }
          : { x: sourceRect.right - gridRect.left + 6, y: centerY(sourceRect, gridRect) },
        componentLeft: vertical
          ? { x: centerX(componentRect, gridRect), y: componentRect.top - gridRect.top - 8 }
          : { x: componentRect.left - gridRect.left - 8, y: centerY(componentRect, gridRect) },
        componentRight: vertical
          ? { x: centerX(componentRect, gridRect), y: componentRect.bottom - gridRect.top + 8 }
          : { x: componentRect.right - gridRect.left + 8, y: centerY(componentRect, gridRect) },
        globe: vertical
          ? { x: centerX(globeRect, gridRect), y: globeRect.top - gridRect.top - 8 }
          : { x: globeRect.left - gridRect.left - 8, y: centerY(globeRect, gridRect) },
        target: targetRect === undefined
          ? undefined
          : vertical
            ? { x: targetRect.left - gridRect.left + 8, y: centerY(targetRect, gridRect) }
            : { x: targetRect.right - gridRect.left + 6, y: centerY(targetRect, gridRect) }
      })
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [selectedSequence, targetSequence])

  if (geometry === null) return <svg className="flow-overlay" aria-hidden="true" />

  const { componentLeft, componentRight, globe, source, target, vertical } = geometry
  const outward = vertical
    ? `M${source.x} ${source.y}C${source.x + 6} ${source.y} ${source.x + 6} ${componentLeft.y} ${componentLeft.x} ${componentLeft.y}`
    : `M${source.x} ${source.y}C${source.x + 56} ${source.y} ${componentLeft.x - 56} ${componentLeft.y} ${componentLeft.x} ${componentLeft.y}`
  const effect = vertical
    ? `M${componentRight.x} ${componentRight.y}C${componentRight.x} ${componentRight.y + 32} ${globe.x} ${globe.y - 32} ${globe.x} ${globe.y}`
    : `M${componentRight.x} ${componentRight.y}C${componentRight.x + 48} ${componentRight.y} ${globe.x - 48} ${globe.y} ${globe.x} ${globe.y}`
  const derived = target === undefined
    ? undefined
    : vertical
      ? `M${componentLeft.x - 24} ${componentLeft.y}C${target.x - 6} ${componentLeft.y} ${target.x - 6} ${target.y} ${target.x} ${target.y}`
      : `M${componentLeft.x} ${componentLeft.y + 28}C${componentLeft.x - 64} ${componentLeft.y + 28} ${target.x + 64} ${target.y} ${target.x} ${target.y}`

  return (
    <svg className="flow-overlay" aria-hidden="true">
      <defs>
        <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L8 4L0 8Z" />
        </marker>
      </defs>
      <path d={outward} pathLength="1" />
      <path className="flow-world-path" d={effect} pathLength="1" />
      {derived === undefined ? null : <path d={derived} pathLength="1" />}
    </svg>
  )
}
