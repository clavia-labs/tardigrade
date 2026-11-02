type Point = readonly [number, number]

/** Turns an `M x y` path of `H`/`V` segments into the same route with each corner rounded by up to `radius`. */
export const roundedPath = (d: string, radius = 10): string => {
  const points: Point[] = []
  for (const [, command, a, b] of d.matchAll(/([MHV])\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?/g)) {
    const last = points.at(-1) ?? [0, 0]
    points.push(command === "M" ? [Number(a), Number(b)] : command === "H" ? [Number(a), last[1]] : [last[0], Number(a)])
  }
  const unit = (from: Point, to: Point): Point => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1
    return [(to[0] - from[0]) / length, (to[1] - from[1]) / length]
  }
  let path = `M${points[0]![0]} ${points[0]![1]}`
  for (let index = 1; index < points.length - 1; index++) {
    const [previous, corner, next] = [points[index - 1]!, points[index]!, points[index + 1]!]
    const r = Math.min(radius, Math.hypot(corner[0] - previous[0], corner[1] - previous[1]) / 2, Math.hypot(next[0] - corner[0], next[1] - corner[1]) / 2)
    const [into, out] = [unit(previous, corner), unit(corner, next)]
    path += `L${corner[0] - into[0] * r} ${corner[1] - into[1] * r}Q${corner[0]} ${corner[1]} ${corner[0] + out[0] * r} ${corner[1] + out[1] * r}`
  }
  const end = points.at(-1)!
  return `${path}L${end[0]} ${end[1]}`
}
