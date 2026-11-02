import type { ReactElement } from "react"

const clips = [
  [268, 215, -28], [303, 220, 64],
  [335, 220, -24], [371, 222, 16], [407, 221, -8], [442, 224, 31],
  [477, 219, -20], [509, 224, 56], [544, 219, -36],
  [263, 195, 53], [298, 192, -42], [330, 189, 18], [363, 194, -24],
  [398, 191, 36], [435, 190, -12], [467, 190, 44], [502, 198, -30], [539, 200, 24],
  [315, 169, -18], [350, 167, 33], [384, 166, -12], [420, 168, 32], [454, 169, -25], [487, 175, 55],
  [354, 146, -35], [391, 143, 17], [428, 147, -22], [462, 151, 42],
  [383, 123, -12], [415, 123, 31], [404, 104, -28],
] as const

const Paperclip = ({ x, y, angle }: { readonly x: number; readonly y: number; readonly angle: number }): ReactElement => (
  <path className="paperclip-wire" transform={`translate(${x} ${y}) rotate(${angle})`} d="M0-11V9a7 7 0 0 0 14 0v-24a10 10 0 0 0-20 0v26a13 13 0 0 0 26 0v-20" />
)

export const PaperclipProblemDiagram = (): ReactElement => (
  <figure className="paperclip-problem">
    <svg viewBox="220 60 370 210" role="img" aria-label="A dense heap of tangled blue paperclips">
      {clips.map(([x, y, angle]) => <Paperclip key={`${x},${y}`} x={x} y={y} angle={angle} />)}
    </svg>
    <figcaption><a href="https://en.wikipedia.org/wiki/Instrumental_convergence#Paperclip_maximizer" target="_blank" rel="noopener noreferrer">The paperclip problem</a>. A simple goal can have unintended consequences.</figcaption>
  </figure>
)
