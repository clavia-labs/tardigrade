import type { ReactElement } from "react"

type PostalStampProps = {
  readonly className: string
  readonly height: number
  readonly id: string
  readonly width: number
  readonly x: number
  readonly y: number
}

const positions = (start: number, length: number, spacing: number): ReadonlyArray<number> => {
  const count = Math.max(1, Math.floor(length / spacing))
  const gap = length / count
  return Array.from({ length: count }, (_, index) => start + gap * (index + 0.5))
}

export const PostalStamp = ({ className, height, id, width, x, y }: PostalStampProps): ReactElement => {
  const horizontal = positions(x, width, 10)
  const vertical = positions(y, height, 10)

  return (
    <g className={className} aria-hidden="true">
      <mask id={id} x={x - 4} y={y - 4} width={width + 8} height={height + 8} maskUnits="userSpaceOnUse">
        <rect x={x} y={y} width={width} height={height} fill="white" />
        {horizontal.flatMap((position) => [
          <circle cx={position} cy={y} r="2.4" fill="black" key={`top-${position}`} />,
          <circle cx={position} cy={y + height} r="2.4" fill="black" key={`bottom-${position}`} />
        ])}
        {vertical.flatMap((position) => [
          <circle cx={x} cy={position} r="2.4" fill="black" key={`left-${position}`} />,
          <circle cx={x + width} cy={position} r="2.4" fill="black" key={`right-${position}`} />
        ])}
      </mask>
      <rect className="postal-stamp-fill" x={x} y={y} width={width} height={height} mask={`url(#${id})`} />
      <rect className="postal-stamp-inset" x={x + 5} y={y + 5} width={width - 10} height={height - 10} />
    </g>
  )
}
