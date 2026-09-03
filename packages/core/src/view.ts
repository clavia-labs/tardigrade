/**
 * ViewAlgebra defines how independently projected views compose into the value observed by their parent.
 *
 *   ViewA ─┐
 *   ViewB ─┼─> combine ─> ParentView
 *   ViewC ─┘
 *
 * empty represents the view contributed by no components. combine joins two component views in mount order.
 *
 * Every algebra must preserve these laws:
 *
 *   combine(empty, view) = view
 *   combine(view, empty) = view
 *   combine(combine(a, b), c) = combine(a, combine(b, c))
 *
 * These identity and associativity laws let Tardigrade regroup a component tree
 * without changing its observable view (component/compose.properties.test.ts, "empty is an identity and combine is associative").
 */
export interface ViewAlgebra<View> {
  readonly empty: View
  readonly combine: (left: View, right: View) => View
}
