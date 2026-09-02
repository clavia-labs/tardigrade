// ViewAlgebra defines the identity and associative combination for independently projected views (actor/component.properties.test.ts, "empty is an identity and combine is associative").
export interface ViewAlgebra<View> {
  readonly empty: View
  readonly combine: (left: View, right: View) => View
}
