import { isFrozenJson } from "@tardie/grove"

// FrozenPlainData recognizes locally verified plain data and Grove's immutable JSON values (platform/test/properties/runtime/state-validation.ts; grove/test/value.test.ts).
class FrozenPlainData extends WeakSet<object> {
  override has(value: object): boolean { return super.has(value) || isFrozenJson(value) }
}
export const frozenPlainData = new FrozenPlainData()
