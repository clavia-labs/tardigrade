import type { Maps } from "./key-value"
import type { Logs } from "./append-only"
import { makeKeyed, keyedEntries } from "./tree-keys"
import { FORMAT_VERSION, digest, elementBytes, bytes, descriptor, mergeablePages, payload, plan, type Descriptor, type Json, type Node, type Options, type Path, type Tree, DEFAULT_FANOUT, DEFAULT_LEAF_BYTES, DEFAULT_PAGE_ITEMS, DEFAULT_TAIL_BYTES, DEFAULT_OBJECT_PAGE_ITEMS } from "../storage/nodes"

export type Edit = { readonly type: "set"; readonly path: Path; readonly value: Json } | { readonly type: "append"; readonly path: Path; readonly values: readonly Json[] } | { readonly type: "splice"; readonly path: Path; readonly index: number; readonly deleteCount: number; readonly values: readonly Json[] } | { readonly type: "entry"; readonly path: Path; readonly key: string; readonly value?: Json } | { readonly type: "remove"; readonly path: Path }

const embedded = new WeakMap<object, Node>()
// embed carries an internally prepared node through an import without exposing a storage representation in JSON (test/append-only.test.ts).
export const embed = (node: Node): Json => { const token = Object.freeze({}); embedded.set(token, node); return token }

// make's memo reuses nodes for repeated imports of the same frozen values; a builder that only edits loaded trees passes memo: false so it retains no built nodes.
export function make(options: Options = {}, { memo = true, logs, maps }: { readonly memo?: boolean; readonly logs?: Logs; readonly maps?: Maps } = {}) {
  const pageItems = options.pageItems ?? DEFAULT_PAGE_ITEMS
  const objectPageItems = options.objectPageItems ?? DEFAULT_OBJECT_PAGE_ITEMS
  const fanout = options.fanout ?? DEFAULT_FANOUT
  const leafBytes = options.leafBytes ?? DEFAULT_LEAF_BYTES
  const tailBytes = Math.min(options.tailBytes ?? DEFAULT_TAIL_BYTES, leafBytes)
  for (const [name, value] of Object.entries({ pageItems, fanout, leafBytes, tailBytes, objectPageItems })) if (!Number.isSafeInteger(value) || value < 2) throw new Error(`${name} must be at least two`)
  const classified = new WeakMap<object, { immutable: boolean; large: boolean }>()
  const imported = new WeakMap<object, Node>()
  const pages = new WeakMap<object, { items: readonly Json[]; node: Node }>()
  let metrics = { hashedNodes: 0, hashedBytes: 0, visitedValues: 0, reusedNodes: 0 }
  const classify = (value: Json): { immutable: boolean; large: boolean } => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Merkle numbers must be finite")
    if (typeof value !== "object" || value === null) return { immutable: true, large: false }
    if (embedded.has(value)) return { immutable: true, large: true }
    const cached = classified.get(value)
    if (cached) return cached
    const plain = Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
    let immutable = plain && Object.isFrozen(value)
    let large = Array.isArray(value) && value.length > pageItems
    if (immutable) immutable = Object.values(Object.getOwnPropertyDescriptors(value)).every(d => "value" in d)
    if (immutable || !large) for (const child of Object.values(value) as readonly Json[]) {
      const classification = classify(child)
      immutable &&= classification.immutable
      large ||= classification.large
      if (large && !immutable) break
    }
    const result = { immutable, large }
    if (result.immutable) classified.set(value, result)
    return result
  }
  const make = (tag: Node["tag"], payload: unknown, links: readonly Node[], logicalBytes: number, count = 0, level = 0, raw?: string): Node => {
    const text = raw === undefined ? JSON.stringify([FORMAT_VERSION, tag, payload]) : `[${FORMAT_VERSION},${JSON.stringify(tag)},${raw}]`
    metrics.hashedNodes++
    metrics.hashedBytes += bytes(text)
    return Object.freeze({ hash: digest(text), text, tag, links: Object.freeze([...links]), children: Object.freeze(links.map(child => child.hash)), logicalBytes, count, level })
  }
  const keyed = makeKeyed(make, objectPageItems, fanout)
  const leaf = (value: Json) => {
    const text = JSON.stringify(value)
    if (text === undefined) throw new Error("Merkle values must be JSON")
    return make("v", undefined, [], bytes(text), 0, 0, text)
  }
  const refs = (children: readonly Node[]) => make("r", children.map(descriptor), children, 2 + children.reduce((n, child) => n + child.logicalBytes, 0) + Math.max(0, children.length - 1), children.length)
  const concat = (children: readonly Node[]) => {
    const count = children.reduce((n, child) => n + child.count, 0)
    return make("c", children.map(descriptor), children, 2 + children.reduce((n, child) => n + elementBytes(child), 0) + Math.max(0, count - 1), count, children[0]!.level + 1)
  }
  const array = (segment: Node) => make("a", descriptor(segment), [segment], segment.logicalBytes, segment.count)
  const object = (fields: readonly [string, Node][]) => fields.length > objectPageItems ? keyed.build(fields) : make("o", fields.map(([key, child]) => [key, descriptor(child)]), fields.map(([, child]) => child), 2 + Math.max(0, fields.length - 1) + fields.reduce((n, [key, child]) => n + bytes(JSON.stringify(key)) + 1 + child.logicalBytes, 0))
  const page = (items: readonly Json[]): Node => {
    const first = items[0]
    const immutable = items.every(item => classify(item).immutable)
    const lead = immutable && first !== null && typeof first === "object" ? first : undefined
    const cached = lead && pages.get(lead)
    if (cached && cached.items.length === items.length && items.every((item, index) => item === cached.items[index])) { metrics.reusedNodes++; return cached.node }
    let node: Node
    if (items.some(item => classify(item).large)) node = refs(items.map(importValue))
    else {
      const text = JSON.stringify(items)
      node = bytes(text) > leafBytes && (items.length > 1 || first !== null && typeof first === "object") ? refs(items.map(importValue)) : make("p", undefined, [], bytes(text), items.length, 0, text)
    }
    if (lead && memo) pages.set(lead, { items: Object.freeze([...items]), node })
    return node
  }
  const importValue = (value: Json): Node => {
    metrics.visitedValues++
    const objectValue = value !== null && typeof value === "object" ? value : undefined
    const prepared = objectValue && embedded.get(objectValue)
    if (prepared) { metrics.reusedNodes++; return prepared }
    const cached = objectValue && imported.get(objectValue)
    if (cached) { metrics.reusedNodes++; return cached }
    const classification = classify(value)
    let node: Node | undefined
    if (!classification.large) {
      const text = JSON.stringify(value)
      if (text === undefined) throw new Error("Merkle values must be JSON")
      // A container above tailBytes is structured so appends and sets inside it rewrite only the changed path (test/tree.test.ts).
      if (!objectValue || bytes(text) <= tailBytes) node = make("v", undefined, [], bytes(text), 0, 0, text)
    }
    if (!node && Array.isArray(value)) {
      let segments: Node[] = []
      let items: Json[] = []
      let size = 2
      for (const item of value) {
        const itemBytes = bytes(JSON.stringify(item))
        if (items.length && (items.length >= pageItems || size + itemBytes + 1 > leafBytes)) { segments.push(page(items)); items = []; size = 2 }
        size += itemBytes + Number(items.length > 0)
        items.push(item)
      }
      if (items.length || !segments.length) segments.push(page(items))
      while (segments.length > 1) {
        const parents: Node[] = []
        for (let start = 0; start < segments.length; start += fanout) parents.push(concat(segments.slice(start, start + fanout)))
        segments = parents
      }
      node = array(segments[0]!)
    }
    if (!node) node = object(Object.entries(value as Record<string, Json>).filter(([, child]) => child !== undefined).map(([key, child]) => [key, importValue(child)]))
    if (objectValue && classification.immutable && memo) imported.set(objectValue, node)
    return node
  }

  const ordered = (node: Node): [string, number, Json][] => {
    if (node.opaque) throw new Error("Merkle reference requires an explicit read")
    return node.tag === "k" ? keyedEntries(node).map(([key, order, value]) => [key, order, materialize(value)]) : node.links.flatMap(ordered)
  }
  const materialize = (node: Node): Json => {
    if (node.opaque) throw new Error("Merkle reference requires an explicit read")
    switch (node.tag) {
      case "m": if (!maps) throw new Error("Key-value storage is unavailable"); return maps.materialize(node)
      case "l": if (!logs) throw new Error("Log rows are unavailable"); return logs.read(node, 0, node.count)
      case "k": case "b": return Object.fromEntries(ordered(node).sort((a, b) => a[1] - b[1]).map(([key, , value]) => [key, value]))
      case "v": case "p": return payload(node)
      case "a": return materialize(node.links[0]!)
      case "r": return node.links.map(materialize)
      case "c": return node.links.flatMap(child => materialize(child) as readonly Json[])
      case "o": return Object.fromEntries((payload(node) as readonly (readonly [string, Descriptor])[]).map(([key], index) => [key, materialize(node.links[index]!)]))
    }
  }
  const fieldNames = (node: Node) => (payload(node) as readonly (readonly [string, Descriptor])[]).map(([key]) => key)
  const patchJson = (value: Json, path: Path, update: (value: Json) => Json): Json => {
    if (!path.length) return update(value)
    const [key, ...tail] = path
    if (Array.isArray(value)) {
      if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0 || key >= value.length) throw new Error("Invalid array path")
      const items = [...value]; items[key] = patchJson(items[key]!, tail, update); return items
    }
    if (value === null || typeof value !== "object" || typeof key !== "string") throw new Error("Invalid object path")
    const fields = value as Record<string, Json>
    if (tail.length && !Object.hasOwn(fields, key)) throw new Error("Missing object path")
    const entries = Object.entries(fields).map(([name, child]) => [name, name === key ? patchJson(child, tail, update) : child])
    if (!Object.hasOwn(fields, key)) entries.push([key, patchJson(null, tail, update)])
    return Object.fromEntries(entries)
  }
  const updateSegment = (segment: Node, index: number, update: (node: Node) => Node): Node => {
    if (segment.tag === "p") {
      const items = [...(materialize(segment) as Json[])]
      items[index] = materialize(update(importValue(items[index]!)))
      return page(items)
    }
    const children = [...segment.links]
    if (segment.tag === "r") children[index] = update(children[index]!)
    else {
      let offset = index
      const childIndex = children.findIndex(child => { if (offset < child.count) return true; offset -= child.count; return false })
      children[childIndex] = updateSegment(children[childIndex]!, offset, update)
    }
    return segment.tag === "r" ? refs(children) : concat(children)
  }
  const updateAt = (node: Node, path: Path, update: (node: Node) => Node): Node => {
    metrics.visitedValues++
    if (!path.length) return update(node)
    const [key, ...tail] = path
    if (node.tag === "v") return importValue(patchJson(materialize(node), path, value => materialize(update(importValue(value)))))
    if (node.tag === "a") {
      if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0 || key >= node.count) throw new Error("Invalid array path")
      return array(updateSegment(node.links[0]!, key, child => updateAt(child, tail, update)))
    }
    if ((node.tag === "k" || node.tag === "b") && typeof key === "string") return keyed.edit(node, key, value => {
      if (!value && tail.length) throw new Error("Missing object path")
      return updateAt(value ?? leaf(null), tail, update)
    })
    if (node.tag !== "o" || typeof key !== "string") throw new Error("Invalid object path")
    const names = fieldNames(node)
    const index = names.indexOf(key)
    if (index < 0 && tail.length) throw new Error("Missing object path")
    const fields: [string, Node][] = names.map((name, i) => [name, node.links[i]!])
    if (index < 0) fields.push([key, updateAt(leaf(null), tail, update)])
    else fields[index] = [key, updateAt(node.links[index]!, tail, update)]
    return object(fields)
  }
  const push = (segment: Node, item: Node): readonly Node[] => {
    if (segment.level === 0) {
      if (segment.count >= pageItems || segment.count > 0 && segment.logicalBytes + item.logicalBytes + 1 > tailBytes) return [segment, item.tag === "v" ? page([materialize(item)]) : refs([item])]
      if (segment.tag === "p" && item.tag === "v") return [page([...(materialize(segment) as Json[]), materialize(item)])]
      const children = segment.tag === "r" ? segment.links : (materialize(segment) as Json[]).map(importValue)
      return [refs([...children, item])]
    }
    const children = [...segment.links]
    const tail = push(children.pop()!, item)
    const previous = children.at(-1)
    if (tail[1] && previous && !previous.opaque && mergeablePages(previous, tail[0]!, pageItems, leafBytes)) children[children.length - 1] = page([...(materialize(previous) as Json[]), ...(materialize(tail[0]!) as Json[])])
    else children.push(tail[0]!)
    if (tail[1]) children.push(tail[1])
    return children.length <= fanout ? [concat(children)] : [concat(children.slice(0, fanout)), concat(children.slice(fanout))]
  }
  const append = (node: Node, values: readonly Json[]): Node => {
    if (node.tag === "l") { if (!logs) throw new Error("Log rows are unavailable"); return logs.append(node, values) }
    if (node.tag === "v") {
      const value = materialize(node)
      if (!Array.isArray(value)) throw new Error("Append target must be an array")
      return importValue([...value, ...values])
    }
    if (node.tag !== "a") throw new Error("Append target must be an array")
    let segment = node.links[0]!
    for (const value of values) {
      const next = push(segment, importValue(value))
      segment = next.length === 1 ? next[0]! : concat(next)
    }
    return array(segment)
  }
  const removeField = (node: Node, key: string): Node => {
    if (node.tag === "v") {
      const value = materialize(node)
      if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Removal target must be an object")
      if (!Object.hasOwn(value, key)) return node
      return importValue(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)))
    }
    if (node.tag === "k" || node.tag === "b") return keyed.edit(node, key, () => undefined, true)
    if (node.tag !== "o") throw new Error("Removal target must be an object")
    const names = fieldNames(node)
    if (!names.includes(key)) return node
    return object(names.flatMap((name, index) => name === key ? [] : [[name, node.links[index]!] as [string, Node]]))
  }
  const cut = (node: Node, start: number, end: number): Node | null => {
    if (start === end) return null
    if (start === 0 && end === node.count) return node
    if (node.opaque) throw new Error("Splice boundary requires an explicit read")
    if (node.tag === "p") return page((payload(node) as readonly Json[]).slice(start, end))
    if (node.tag === "r") return refs(node.links.slice(start, end))
    if (node.tag !== "c") throw new Error("Invalid splice segment")
    let offset = 0
    const children: Node[] = []
    for (const child of node.links) {
      if (offset >= end) break
      if (offset + child.count > start) {
        const part = cut(child, Math.max(0, start - offset), Math.min(child.count, end - offset))
        if (part) children.push(part)
      }
      offset += child.count
    }
    return concat(children)
  }
  const pack = (children: readonly Node[]): readonly Node[] => {
    if (children.length <= fanout) return [concat(children)]
    const middle = Math.ceil(children.length / 2)
    return [concat(children.slice(0, middle)), concat(children.slice(middle))]
  }
  const join = (left: Node, right: Node): readonly Node[] => {
    if (left.level === 0 && right.level === 0) {
      if (left.count + right.count <= pageItems) {
        if (!left.opaque && !right.opaque && mergeablePages(left, right, pageItems, leafBytes)) return [page([...(payload(left) as readonly Json[]), ...(payload(right) as readonly Json[])])]
        if (left.tag === "r" && right.tag === "r" && !left.opaque && !right.opaque) return [refs([...left.links, ...right.links])]
      }
      return [left, right]
    }
    if ((left.level >= right.level && left.opaque) || (right.level >= left.level && right.opaque)) throw new Error("Splice join requires an explicit read")
    if (left.level === right.level) return pack([...left.links.slice(0, -1), ...join(left.links.at(-1)!, right.links[0]!), ...right.links.slice(1)])
    if (left.level > right.level) return pack([...left.links.slice(0, -1), ...join(left.links.at(-1)!, right)])
    return pack([...join(left, right.links[0]!), ...right.links.slice(1)])
  }
  const connect = (left: Node | null, right: Node | null): Node | null => {
    if (!left) return right
    if (!right) return left
    const joined = join(left, right)
    return joined.length === 1 ? joined[0]! : concat(joined)
  }
  // splice rebuilds boundary segments and shares untouched storage (test/edits.test.ts).
  const splice = (node: Node, index: number, deleteCount: number, values: readonly Json[]): Node => {
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(deleteCount) || index < 0 || deleteCount < 0) throw new RangeError("Invalid splice bounds")
    if (node.tag === "v") {
      const items = materialize(node)
      if (!Array.isArray(items)) throw new Error("Splice target must be an array")
      if (index > items.length || deleteCount > items.length - index) throw new RangeError("Invalid splice bounds")
      if (!deleteCount && !values.length) return node
      return importValue([...items.slice(0, index), ...values, ...items.slice(index + deleteCount)])
    }
    if (node.tag !== "a") throw new Error("Splice target must be an array")
    if (index > node.count || deleteCount > node.count - index) throw new RangeError("Invalid splice bounds")
    if (!deleteCount && !values.length) return node
    const source = node.links[0]!
    const inserted = values.length ? importValue(values) : null
    const insertion = inserted?.tag === "a" ? inserted.links[0]! : values.length ? page(values) : null
    let segment = connect(connect(cut(source, 0, index), insertion), cut(source, index + deleteCount, node.count)) ?? page([])
    while (segment.tag === "c" && segment.links.length === 1) segment = segment.links[0]!
    return array(segment)
  }
  const apply = (node: Node, edit: Edit): Node => {
    if (edit.type === "entry") return updateAt(node, edit.path, child => { if (!maps || child.tag !== "m") throw new Error("Invalid key-value target"); return maps.change(child, edit.key, edit.value) })
    if (edit.type === "remove") {
      const key = edit.path.at(-1)
      if (typeof key !== "string") throw new Error("Removal target must be an object field")
      return updateAt(node, edit.path.slice(0, -1), parent => removeField(parent, key))
    }
    return updateAt(node, edit.path, child => {
      if (edit.type === "set") return importValue(edit.value)
      if (edit.type === "append") return append(child, edit.values)
      return splice(child, edit.index, edit.deleteCount, edit.values)
    })
  }
  const groups = (edits: readonly Edit[]) => {
    const result = new Map<string | number, Edit[]>()
    for (const edit of edits) {
      const [key, ...path] = edit.path
      const group = result.get(key!) ?? []
      group.push({ ...edit, path }); result.set(key!, group)
    }
    return result
  }
  const editSegment = (node: Node, edits: readonly Edit[]): Node => {
    if (node.tag === "p") {
      let current = node
      for (const edit of edits) current = updateSegment(current, edit.path[0] as number, child => apply(child, { ...edit, path: edit.path.slice(1) }))
      return current
    }
    if (node.tag === "r") {
      const links = [...node.links]
      for (const [key, group] of groups(edits)) links[key as number] = batch(links[key as number]!, group)
      return refs(links)
    }
    let offset = 0
    return concat(node.links.map(child => {
      const start = offset; offset += child.count
      const group = edits.filter(edit => (edit.path[0] as number) >= start && (edit.path[0] as number) < offset).map(edit => ({ ...edit, path: [(edit.path[0] as number) - start, ...edit.path.slice(1)] }))
      return group.length ? editSegment(child, group) : child
    }))
  }
  // batch preserves edit order within each subtree and hashes shared structured ancestors once between whole-subtree edits (test/tree.test.ts).
  const batch = (original: Node, edits: readonly Edit[]): Node => {
    if (!edits.length) return original
    const replacement = edits.findIndex(edit => !edit.path.length || edit.type === "remove" && edit.path.length === 1)
    if (replacement >= 0) {
      const before = batch(original, edits.slice(0, replacement))
      return batch(apply(before, edits[replacement]!), edits.slice(replacement + 1))
    }
    if (original.tag === "v") return edits.reduce(apply, original)
    if (original.tag === "a") {
      for (const edit of edits) {
        const key = edit.path[0]
        if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0 || key >= original.count) throw new Error("Invalid array path")
      }
      return array(editSegment(original.links[0]!, edits))
    }
    if (original.tag === "m" || original.tag === "k" || original.tag === "b") return edits.reduce(apply, original)
    if (original.tag !== "o") throw new Error("Invalid object path")
    const fields: [string, Node][] = fieldNames(original).map((key, index) => [key, original.links[index]!])
    for (const [key, group] of groups(edits)) {
      if (typeof key !== "string") throw new Error("Invalid object path")
      const index = fields.findIndex(([name]) => name === key)
      if (index < 0) {
        if (group[0]!.path.length) throw new Error("Missing object path")
        fields.push([key, batch(leaf(null), group)])
      } else fields[index] = [key, batch(fields[index]![1], group)]
    }
    return object(fields)
  }
  const run = (work: () => Node) => {
    metrics = { hashedNodes: 0, hashedBytes: 0, visitedValues: 0, reusedNodes: 0 }
    return plan(work(), metrics)
  }
  return {
    from: (value: Json) => run(() => importValue(value)),
    entry: (plan: Tree, path: Path, key: string, value: Json | undefined) => run(() => updateAt(plan.node, path, node => { if (!maps || node.tag !== "m") throw new Error("Invalid key-value target"); return maps.change(node, key, value) })),
    set: (plan: Tree, path: Path, value: Json) => run(() => updateAt(plan.node, path, () => importValue(value))),
    append: (plan: Tree, path: Path, values: readonly Json[]) => run(() => updateAt(plan.node, path, node => append(node, values))),
    splice: (plan: Tree, path: Path, index: number, deleteCount: number, values: readonly Json[] = []) => run(() => apply(plan.node, { type: "splice", path, index, deleteCount, values })),
    remove: (plan: Tree, path: Path) => run(() => apply(plan.node, { type: "remove", path })),
    batch: (plan: Tree, edits: readonly Edit[]) => run(() => batch(plan.node, edits)),
    materialize: (plan: Tree) => materialize(plan.node),
  }
}
