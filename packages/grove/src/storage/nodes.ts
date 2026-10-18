import { createHash } from "node:crypto"

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }
export const FORMAT_VERSION = 4
export type Path = readonly (string | number)[]
export const DEFAULT_PAGE_ITEMS = 64
export const DEFAULT_FANOUT = 32
export const DEFAULT_LEAF_BYTES = 128 * 1024
// DEFAULT_TAIL_BYTES caps the page that appends rewrite; a sealed tail merges into its previous page up to DEFAULT_LEAF_BYTES (test/tree.test.ts).
export const DEFAULT_TAIL_BYTES = 16 * 1024
export const DEFAULT_OBJECT_PAGE_ITEMS = 64
export interface Node {
  readonly version?: number
  readonly order?: number
  readonly firstKey?: string | null
  readonly lastKey?: string | null
  readonly hash: string
  readonly opaque?: true
  readonly payload?: Json
  readonly text: string
  readonly children: readonly string[]
  readonly links: readonly Node[]
  readonly tag: "v" | "p" | "r" | "c" | "a" | "o" | "k" | "b" | "l" | "m"
  readonly logicalBytes: number
  readonly count: number
  readonly level: number
}
export interface Metrics { readonly hashedNodes: number; readonly hashedBytes: number; readonly visitedValues: number; readonly reusedNodes: number }
export interface Tree {
  readonly root: string
  readonly logicalBytes: number
  readonly node: Node
  readonly metrics: Metrics
  readonly nodes: ReadonlyMap<string, Node>
}
export interface Options { readonly pageItems?: number; readonly fanout?: number; readonly leafBytes?: number; readonly tailBytes?: number; readonly objectPageItems?: number }
// mergeablePages reports whether two adjacent packed pages fit one page, using descriptor metadata alone.
export const mergeablePages = (left: Node, right: Node, pageItems: number, leafBytes: number) => left.tag === "p" && right.tag === "p" && left.count + right.count <= pageItems && left.logicalBytes + right.logicalBytes - 1 <= leafBytes
export const bytes = (text: string) => Buffer.byteLength(text, "utf8")
export const digest = (text: string) => createHash("sha256").update(text).digest("hex")
export const elementBytes = (node: Node) => node.logicalBytes - 2 - Math.max(0, node.count - 1)

// missingNodes lists nodes built in memory; decoded nodes carry no text because they were read from storage (decodeNode).
function missingNodes(root: Node): readonly Node[] {
  const found = new Map<string, Node>()
  const walk = (node: Node) => {
    if (node.opaque || !node.text || found.has(node.hash)) return
    for (const child of node.links) walk(child)
    found.set(node.hash, node)
  }
  walk(root)
  return [...found.values()]
}

export const plan = (node: Node, metrics: Metrics): Tree => {
  let nodes: ReadonlyMap<string, Node> | undefined
  return Object.freeze({ root: node.hash, logicalBytes: node.logicalBytes, node, metrics: Object.freeze({ ...metrics }), get nodes() {
    return nodes ??= new Map(missingNodes(node).map(node => [node.hash, node]))
  } })
}

// Descriptor authenticates child sizes and levels so cold edits can leave siblings unloaded (test/tree.test.ts).
export type Descriptor = readonly [hash: string, tag: Node["tag"], logicalBytes: number, count: number, level: number, ...keyed: [] | [order: number, firstKey: string | null, lastKey: string | null]]
export const descriptor = (node: Node): Descriptor => node.tag === "k" || node.tag === "b" ? [node.hash, node.tag, node.logicalBytes, node.count, node.level, node.order!, node.firstKey!, node.lastKey!] : [node.hash, node.tag, node.logicalBytes, node.count, node.level]
export const payload = (node: Node): Json => {
  if (node.opaque) throw new Error("Merkle reference requires an explicit read")
  return "payload" in node ? node.payload! : (JSON.parse(node.text) as readonly [number, string, Json])[2]
}
const tags = ["v", "p", "r", "c", "a", "o", "k", "b", "l", "m"] as const
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const frozenJson = new WeakSet<object>()
// isFrozenJson recognizes plain JSON verified and frozen by Grove (test/value.test.ts).
export const isFrozenJson = (value: unknown): boolean => typeof value === "object" && value !== null && frozenJson.has(value)
export const freezeJson = (value: unknown): Json => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value && typeof value === "object") {
    if (frozenJson.has(value)) return value as Json
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    let plain = (array ? prototype === Array.prototype && Object.keys(value).length === value.length : prototype === Object.prototype || prototype === null)
      && Reflect.ownKeys(descriptors).every(key => typeof key === "string" && "value" in descriptors[key]! && (descriptors[key]!.enumerable || array && key === "length"))
    for (const child of Object.values(value)) {
      freezeJson(child)
      if (child !== null && typeof child === "object" && !frozenJson.has(child)) plain = false
    }
    Object.freeze(value)
    if (plain) frozenJson.add(value)
    return value as Json
  }
  throw new Error("Merkle values must be finite JSON")
}
const opaque = (value: unknown): Node => {
  if (!Array.isArray(value) || (value.length !== 5 && value.length !== 8) || typeof value[0] !== "string" || !/^[a-f0-9]{64}$/.test(value[0]) || !tags.includes(value[1]) || !natural(value[2]) || value[2] < 1 || !natural(value[3]) || !natural(value[4])) throw new Error("Invalid Merkle child descriptor")
  const entry: Descriptor = [value[0], value[1] as Node["tag"], value[2], value[3], value[4]]
  const [hash, tag, logicalBytes, count, level] = entry
  const keyed = tag === "k" || tag === "b"
  if (keyed ? value.length !== 8 || !natural(value[5]) || (count === 0 ? value[6] !== null || value[7] !== null : typeof value[6] !== "string" || typeof value[7] !== "string" || value[6] > value[7]) || (tag === "k" ? level !== 0 : level < 1 || count < 1) : value.length !== 5) throw new Error("Invalid Merkle keyed metadata")
  if (tag !== "c" && tag !== "b" && level !== 0 || (tag === "v" || tag === "o") && count !== 0) throw new Error("Invalid Merkle child metadata")
  return Object.freeze({ hash, tag, logicalBytes, count, level, text: "", links: Object.freeze([]), children: Object.freeze([]), opaque: true, ...(keyed ? { order: value[5] as number, firstKey: value[6] as string | null, lastKey: value[7] as string | null } : {}) })
}
export const matchNode = (expected: Node, actual: Node) => {
  if (expected.hash !== actual.hash || expected.tag !== actual.tag || expected.logicalBytes !== actual.logicalBytes || expected.count !== actual.count || expected.level !== actual.level || expected.order !== actual.order || expected.firstKey !== actual.firstKey || expected.lastKey !== actual.lastKey) throw new Error("Merkle child metadata mismatch")
  return actual
}
// decodeNode verifies text against hash and keeps only the frozen payload; the text is not retained (encodeNode).
export function decodeNode(hash: string, text: string): Node {
  if (digest(text) !== hash) throw new Error(`Shared JSON node missing or corrupt: ${hash}`)
  const decoded: unknown = JSON.parse(text)
  if (!Array.isArray(decoded) || decoded.length !== 3) throw new Error("Invalid Merkle node header")
  const [version, tag, payload]: readonly unknown[] = decoded
  if (version !== FORMAT_VERSION && version !== 3) throw new Error("Unsupported Merkle JSON format version")
  if (typeof tag !== "string" || !tags.includes(tag as Node["tag"])) throw new Error("Invalid shared JSON node tag")
  let links: readonly Node[] = []
  let logicalBytes: number
  let count = 0
  let level = 0
  let keyed: { order: number; firstKey: string | null; lastKey: string | null } | undefined
  switch (tag) {
    case "v": logicalBytes = bytes(JSON.stringify(payload)); break
    case "m":
      if (version === 3 || !Array.isArray(payload) || payload.length !== 4 || typeof payload[0] !== "string" || !/^[a-f0-9]{64}$/.test(payload[0]) || !natural(payload[1]) || !natural(payload[2]) || !natural(payload[3]) || payload[3] < payload[1] || payload[2] < 2 + payload[1] * 4 + Math.max(0, payload[1] - 1) || payload[1] === 0 && (payload[2] !== 2 || payload[3] !== 0)) throw new Error("Invalid Grove key-value version")
      count = payload[1]; logicalBytes = payload[2]; break
    case "l":
      if (version === 3 || !Array.isArray(payload) || payload.length !== 3 || typeof payload[0] !== "string" || !/^[a-f0-9]{64}$/.test(payload[0]) || !natural(payload[1]) || !natural(payload[2]) || payload[2] < 2 + payload[1] + Math.max(0, payload[1] - 1) || payload[1] === 0 && payload[2] !== 2) throw new Error("Invalid Grove log version")
      count = payload[1]; logicalBytes = payload[2]; break
    case "p":
      if (!Array.isArray(payload)) throw new Error("Invalid Merkle page")
      count = payload.length; logicalBytes = bytes(JSON.stringify(payload)); break
    case "a": {
      const segment = opaque(payload)
      if (!["p", "r", "c"].includes(segment.tag)) throw new Error("Invalid Merkle array segment")
      links = [segment]; logicalBytes = segment.logicalBytes; count = segment.count; break
    }
    case "r": case "c":
      if (!Array.isArray(payload) || tag === "c" && !payload.length) throw new Error("Invalid Merkle sequence manifest")
      links = payload.map(opaque)
      if (tag === "r") { count = links.length; logicalBytes = 2 + links.reduce((n, child) => n + child.logicalBytes, 0) + Math.max(0, count - 1) }
      else {
        if (links.some(child => !["p", "r", "c"].includes(child.tag) || child.level !== links[0]!.level)) throw new Error("Invalid Merkle sequence levels")
        count = links.reduce((n, child) => n + child.count, 0); level = links[0]!.level + 1
        logicalBytes = 2 + links.reduce((n, child) => n + elementBytes(child), 0) + Math.max(0, count - 1)
      }
      break
    case "k": {
      if (version === 3 || !Array.isArray(payload) || !payload.every(entry => Array.isArray(entry) && entry.length === 3 && typeof entry[0] === "string" && natural(entry[1])) || payload.some((entry, index) => index > 0 && payload[index - 1][0] >= entry[0]) || new Set(payload.map(entry => entry[1])).size !== payload.length) throw new Error("Invalid Merkle keyed page")
      links = payload.map(entry => opaque(entry[2]))
      count = links.length
      logicalBytes = 2 + Math.max(0, count - 1) + links.reduce((sum, child, index) => sum + bytes(JSON.stringify(payload[index][0])) + 1 + child.logicalBytes, 0)
      keyed = { order: payload.reduce((max, entry) => Math.max(max, entry[1]), 0), firstKey: payload[0]?.[0] ?? null, lastKey: payload.at(-1)?.[0] ?? null }
      break
    }
    case "b": {
      if (version === 3 || !Array.isArray(payload) || !payload.length) throw new Error("Invalid Merkle keyed branch")
      links = payload.map(opaque)
      if (links.some((child, index) => !["k", "b"].includes(child.tag) || !child.count || child.level !== links[0]!.level || index > 0 && links[index - 1]!.lastKey! >= child.firstKey!)) throw new Error("Invalid Merkle keyed bounds")
      count = links.reduce((sum, child) => sum + child.count, 0)
      level = links[0]!.level + 1
      logicalBytes = 2 + links.reduce((sum, child) => sum + child.logicalBytes - 2, 0) + links.length - 1
      keyed = { order: links.reduce((max, child) => Math.max(max, child.order!), 0), firstKey: links[0]!.firstKey!, lastKey: links.at(-1)!.lastKey! }
      break
    }
    case "o":
      if (!Array.isArray(payload) || !payload.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string") || new Set(payload.map(pair => pair[0])).size !== payload.length) throw new Error("Invalid Merkle object manifest")
      links = payload.map((pair: [string, unknown]) => opaque(pair[1]))
      logicalBytes = 2 + Math.max(0, links.length - 1) + links.reduce((n, child, i) => n + bytes(JSON.stringify((payload as readonly (readonly [string, unknown])[])[i]![0])) + 1 + child.logicalBytes, 0)
      break
    default: throw new Error("Invalid shared JSON node tag")
  }
  if (!natural(logicalBytes) || !natural(count) || !natural(level)) throw new Error("Invalid Merkle node metadata")
  return Object.freeze({ hash, version: version as number, ...keyed, text: "", tag, payload: freezeJson(payload), links: Object.freeze(links), children: Object.freeze(links.map(child => child.hash)), logicalBytes, count, level })
}

// encodeNode returns a node's stored text; decoded nodes drop their text, so it is re-encoded from the payload and checked against the hash.
export const encodeNode = (node: Node): string => {
  if (node.text) return node.text
  if (node.opaque || !("payload" in node)) throw new Error("Merkle reference requires an explicit read")
  const text = JSON.stringify([node.version ?? FORMAT_VERSION, node.tag, node.payload])
  if (digest(text) !== node.hash) throw new Error(`Merkle node re-encoding differs: ${node.hash}`)
  return text
}
