/**
 * OutputTree caches an associative combination of component outputs.
 *
 *                        combined output
 *                       /               \
 *             combined output        combined output
 *                /      \                /      \
 *              O₁        O₂             O₃       O₄
 *
 * Replacing one leaf recomputes only its path to the root. Stable branches retain their identity (component/compose.test.ts, "composition reuses branches whose child state identities are stable").
 */
export type OutputTree<Output> =
  | { readonly kind: "empty"; readonly end: 0; readonly output: Output }
  | { readonly kind: "leaf"; readonly index: number; readonly end: number; readonly output: Output }
  | {
      readonly kind: "branch"
      readonly end: number
      readonly left: OutputTree<Output>
      readonly right: OutputTree<Output>
      readonly output: Output
    }

// buildOutputTree constructs a balanced cached fold over ordered outputs.
export const buildOutputTree = <Output>(
  outputs: ReadonlyArray<Output>,
  empty: Output,
  combine: (left: Output, right: Output) => Output,
  start = 0,
  end = outputs.length
): OutputTree<Output> => {
  if (start === end) return { kind: "empty", end: 0, output: empty }
  if (end - start === 1) return { kind: "leaf", index: start, end, output: outputs[start]! }
  const middle = start + Math.floor((end - start) / 2)
  const left = buildOutputTree(outputs, empty, combine, start, middle)
  const right = buildOutputTree(outputs, empty, combine, middle, end)
  return { kind: "branch", end: right.end, left, right, output: combine(left.output, right.output) }
}

// replaceOutputTree replaces one leaf and recomputes its ancestor outputs.
export const replaceOutputTree = <Output>(
  tree: OutputTree<Output>,
  index: number,
  output: Output,
  combine: (left: Output, right: Output) => Output
): OutputTree<Output> => {
  if (tree.kind === "leaf") return { kind: "leaf", index, end: tree.end, output }
  if (tree.kind === "empty") return tree
  const left = index < tree.left.end
    ? replaceOutputTree(tree.left, index, output, combine)
    : tree.left
  const right = index < tree.left.end
    ? tree.right
    : replaceOutputTree(tree.right, index, output, combine)
  return { kind: "branch", end: right.end, left, right, output: combine(left.output, right.output) }
}
