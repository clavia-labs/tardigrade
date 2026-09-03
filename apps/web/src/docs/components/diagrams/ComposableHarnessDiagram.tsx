import type { ReactElement } from "react"

export const ComposableHarnessDiagram = (): ReactElement => (
  <svg
    className="composable-harness-diagram"
    viewBox="0 0 200 200"
    role="img"
    aria-label="Three connected puzzle pieces form one agent harness."
  >
    <g className="composable-harness-piece">
      <path d="M100 18H130C130 7 137 0 147 0C157 0 164 7 164 18H182V51C171 51 164 58 164 68C164 78 171 85 182 85V100H150C150 89 143 82 133 82C123 82 116 89 116 100H100V69C111 69 118 62 118 52C118 42 111 35 100 35Z" />
    </g>
    <g className="composable-harness-piece composable-harness-piece-active">
      <path d="M18 100H51C51 89 58 82 68 82C78 82 85 89 85 100H100V132C89 132 82 139 82 149C82 159 89 166 100 166V182H68C68 171 61 164 51 164C41 164 34 171 34 182H18V150C7 150 0 143 0 133C0 123 7 116 18 116Z" />
    </g>
    <g className="composable-harness-piece">
      <path d="M100 100H116C116 89 123 82 133 82C143 82 150 89 150 100H182V132C193 132 200 139 200 149C200 159 193 166 182 166V182H150C150 193 143 200 133 200C123 200 116 193 116 182H100V166C89 166 82 159 82 149C82 139 89 132 100 132Z" />
    </g>
  </svg>
)
