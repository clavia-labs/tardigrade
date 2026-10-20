# Grove B+ tree experiment

An immutable, in-memory B+ tree with `empty`, `get`, `set`, `delete`, and inclusive forward or reverse `scan`. `set` inserts or replaces a value. Keys require a stable total-order comparator; keys and values remain caller-owned references. Pages and entry tuples are frozen. Roots retain snapshots through JavaScript reachability.

```text
leaf:    sorted [key, value] entries
branch:  children + smallest key of each child after the first

set    -> copy search path -> split overflow -> grow root
delete -> copy search path -> redistribute / merge -> shrink root
scan   -> seek once -> traverse with an ancestor stack
```

`DEFAULT_CAPACITY` is 32; `{ capacity }` overrides both leaf entries and branch children, with a minimum of three. Non-root pages contain `ceil(capacity / 2)..capacity` slots. A branch root has at least two children; a leaf root may be empty. Leaves have equal depth, and internal separators identify the next child's minimum. Linked leaf pointers are unnecessary for the version-local stack cursor.

The counters report logical page visits, comparator calls, constructed pages, and entry/reference/separator slots written to page arrays and edit buffers. They include temporary edit buffers, split copies, separator construction, redistribution, and merge shifts. Cursor frames, entry tuples, object metadata, allocator overhead, and garbage collection are outside the slot counter. Visits can include newly constructed siblings during deletion. These are algorithmic work counters rather than disk I/O measurements.

For capacity B, L pages on a root-to-leaf path, and K returned entries:

| Operation | Page visits | Comparisons | Copied slots |
| --- | --- | --- | --- |
| Get | L | O(log N) | 0 |
| Set | L | O(log N) | O(BL) |
| Delete | O(L) | O(log N) | O(BL) |
| Range scan | O(L + K/B) | O(log N + K) | 0 |
| Full scan | O(1 + N/B) | 0 | 0 |

A lookup visits every page on its search path. A changed insertion or replacement constructs one page per existing path level, plus the additional pages required by splits and root growth. Flat immutable page arrays impose O(BL) worst-case copying. Failed deletion and identical replacement preserve the root and construct no pages. Comparator costs depend on the supplied keys and comparator. The measurements and finite tests support these bounds; they do not establish globally optimal constants or provide a formal correctness proof. Lookup and scan bounds assume entries fit the fixed-count page model.

```sh
bun test experimental/grove
bun x --no-install tsc -p experimental/grove/tsconfig.json
bun run experimental/grove/measure.ts
bun run experimental/grove/measure.ts --capacity=8 --max=100000 --samples=512 --order=shuffled --seed=20261020
```

The test suite checks generated histories against a sorted Map, strict occupancy, separator consistency, equal depth, root contraction, sibling redistribution, branching snapshots, forward and reverse ranges, and early iterator termination. Cost budgets cover capacities 3, 4, 8, 32, and 64 across growing trees. The repository gate runs the tests, typecheck, and Effect lint for this experiment.

The measurement runner reports peaks across deterministic probes of each size. `idealVisits` is the minimum height in pages with every page completely full. Incremental splits can produce a taller tree while preserving the occupancy guarantee. The runner accepts ascending, descending, and shuffled insertion order. It reports build time separately from work counts.

Measured with capacity 32, ascending insertion, and 256 probes per operation:

| Entries | Packed minimum visits | Lookup visits | Replacement pages | Delete pages | Scan 100 visits |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 2 | 3 | 3 | 5 | 11 |
| 10,000 | 3 | 4 | 4 | 8 | 12 |
| 100,000 | 4 | 4 | 4 | 7 | 13 |
| 1,000,000 | 4 | 5 | 5 | 9 | 14 |

Descending and shuffled builds were also measured through 100,000 entries. Costs include deletion rebalancing; peak page counts are sampled rather than exhaustive worst cases.

## JSON documents

`document({ capacity })` connects keyed object pages and ranked array pages. `from` encodes JSON, `get(root, path)` returns a subtree handle, and `materialize(node)` reconstructs that subtree. `fields` and `elements` iterate child handles without reconstructing their values. Object fields iterate in key order; object insertion order is outside this representation's contract.

```text
JSON root
  object: field name -> child node      (keyed B+ tree)
  array:  position  -> child node       (ranked B+ tree)
  scalar: null / boolean / number / string

nested edit -> copy container paths -> new root
                                  +-> share untouched pages
```

```ts
import { document } from "./json"

const doc = document({ capacity: 32 })
const before = doc.from({ users: [{ name: "Ada" }, { name: "Lin" }] })
const renamed = doc.set(before, ["users", 0, "name"], "Grace")
const after = doc.splice(renamed, ["users"], 1, 0, [{ name: "Edsger" }])
doc.materialize(doc.get(after, ["users"])!)
```

`set` replaces the root, sets an object field, or updates an existing array element. Parent containers must exist. `remove` deletes an object field. `splice` edits an array, and `append` inserts at its end. Array positions and deletion counts are strict nonnegative safe integers within bounds; splice does not apply JavaScript's negative-index or clamping rules. Empty edits and identical scalar replacements preserve root identity. JSON inputs require finite numbers, dense arrays, acyclic values, and plain objects. Encoding owns immutable nodes, so subsequent input mutation cannot change a snapshot.

## Ranked sequences

`sequence({ capacity })` provides `empty`, `from`, `get`, `set`, `splice`, and half-open `scan(start, end)`. Branches store cumulative child element counts. Binary search locates the child containing an index. Split and join copy boundary paths and rebalance adjacent pages; whole removed subtrees and untouched suffixes require no traversal. Non-root occupancy and equal leaf depth follow the same rules as the keyed tree. The sequence tests check these invariants after generated edits, growth, contraction, and bulk replacement.

For B slots per page, L root-to-leaf levels, K inserted elements, and R returned elements, the structural work targets are O(L) page visits for indexed access, O(BL) copied slots for replacement, O(BL + K) copied slots for splice, and O(L + R/B) visits for range scans. Splice constructs the inserted subtree in O(K) work. These bounds concern fixed-count pages and exclude JSON encoding, materialization, garbage collection, and reclamation of unreachable versions. Nested JSON paths add the navigation costs of their containers.

The measurement runner also reports splice peaks across the selected probes, replacing up to one third of the array with one element. Tests bound structural work by height and inserted size across capacities 3, 4, 8, 32, and 64; counters cover logical visits, constructed pages, and page-array/edit-buffer slot writes. Counts exclude cumulative-count arithmetic, transport tuples, and generator frames.

Persistence, page encoding, byte capacity, cache budgets, durable retention, reducer reconciliation, and atomic event-log publication remain separate work.
