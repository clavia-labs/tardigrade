import { observeRecord, recordEvent, RuntimeError, type JournalQuery, type JournalQueryResult, type Recorded } from "@clavia/tardigrade-core"
import type { Schema } from "effect"
import { DEFAULT_LOG_QUERY_POLICY, type LogQueryPolicy, type LogQuerySource, type Sqlite } from "./types"

const encoder = new TextEncoder()

interface Cursor {
  position: number
  end: number
  base: number
  rows: readonly (readonly unknown[])[]
}

// logQueryPolicy validates consumer limits before allocating a WASM engine.
export function logQueryPolicy(options: Partial<LogQueryPolicy> = {}): LogQueryPolicy {
  const policy = { ...DEFAULT_LOG_QUERY_POLICY, ...options }
  for (const [name, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new RuntimeError(`Query policy ${name} must be a positive safe integer`)
  if (policy.maxQueryChars > 536_870_911 || [policy.maxValueBytes, policy.maxColumns, policy.maxExprDepth].some(value => value > 2_147_483_647)) throw new RuntimeError("Query policy exceeds SQLite integer range")
  if (policy.initialHeapBytes % 65_536 || policy.maxHeapBytes % 65_536 || policy.initialHeapBytes > policy.maxHeapBytes || policy.maxHeapBytes > 4_294_967_296) throw new RuntimeError("Query heap sizes must be aligned WASM pages within the 32-bit address space")
  return policy
}

// bridgeQuery exposes a captured journal prefix through a virtual table without xUpdate (test/scenarios/log/lifecycle.ts).
export function bridgeQuery(sqlite: Sqlite, source: LogQuerySource, request: JournalQuery, policy: LogQueryPolicy): JournalQueryResult {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new RuntimeError("Invalid query row limit")
  if (request.sql.length > policy.maxQueryChars || request.sql.includes("\0")) throw new RuntimeError(`Query exceeds maxQueryChars ${policy.maxQueryChars} or contains NUL`)
  if (!Number.isSafeInteger(request.from) || !Number.isSafeInteger(request.to) || request.from < 0 || request.from > request.to || request.to > source.readPosition()) throw new RuntimeError("Query snapshot range is outside the thread history")
  const c = sqlite.capi, w = sqlite.wasm, vt = sqlite.vtab
  const db = new sqlite.oo1.DB(":memory:", "c")
  const cursors = new Map<number, Cursor>()
  let module: { readonly pointer: number; dispose(): void } | undefined
  let failure: unknown
  let readEvents = 0, readBytes = 0, instructions = 0
  const guarded = (fn: (...args: number[]) => number | void) => (...args: number[]): number => {
    try { return fn(...args) ?? c.SQLITE_OK }
    catch (error) { failure = error; return c.SQLITE_ERROR }
  }
  const cursor = (pointer: number) => {
    const state = cursors.get(pointer)
    if (!state) throw new RuntimeError("Missing query cursor")
    return state
  }
  const encode = (stored: Recorded<unknown>) => {
    const record = observeRecord(stored), event = recordEvent(record)
    const text = JSON.stringify(record)
    readBytes += encoder.encode(text).byteLength
    if (readBytes > policy.maxReadBytes) throw new RuntimeError(`Query exceeds maxReadBytes ${policy.maxReadBytes}`)
    return [null, record.recordedAt ?? null, event !== null && typeof event === "object" && "type" in event && typeof event.type === "string" ? event.type : null, JSON.stringify(event), text]
  }
  const load = (state: Cursor) => {
    if (state.position >= state.end) { state.rows = []; return }
    const remaining = policy.maxReadEvents - readEvents
    if (remaining <= 0) throw new RuntimeError(`Query exceeds maxReadEvents ${policy.maxReadEvents}`)
    const end = Math.min(state.end, state.position + Math.min(policy.pageSize, remaining))
    const records = source.readRange(state.position, end)
    if (records.length !== end - state.position) throw new RuntimeError("Query journal range is unavailable")
    state.base = state.position
    state.rows = records.map(encode)
    readEvents += records.length
  }
  try {
    sqlite.oo1.DB.checkRc(db, c.sqlite3_db_config(db.pointer, c.SQLITE_DBCONFIG_DEFENSIVE, 1, 0))
    db.exec("PRAGMA trusted_schema=OFF")
    // functions requires every overload to carry SQLite's side-effect classification (https://sqlite.org/c3ref/c_deterministic.html).
    const functions = new Set(db.selectValues(`SELECT name FROM pragma_function_list GROUP BY name HAVING min((flags & ${c.SQLITE_INNOCUOUS}) != 0) = 1`).map(name => String(name).toLowerCase()))
    module = new c.sqlite3_module().setupModule({ catchExceptions: true, methods: {
      xCreate: true,
      xConnect: guarded((database, _aux, _argc, _argv, output) => {
        const rc = c.sqlite3_declare_vtab(database!, "CREATE TABLE events(position INTEGER, recorded_at INTEGER, type TEXT, event TEXT, record TEXT)")
        if (rc) return rc
        vt.xVtab.create(output!)
      }),
      xDisconnect: pointer => { vt.xVtab.dispose(pointer!); return 0 },
      xDestroy: true,
      xOpen: (_table, output) => {
        const handle = vt.xCursor.create(output!)
        cursors.set(handle.pointer, { position: request.from, end: request.to, base: request.from, rows: [] })
        return 0
      },
      xClose: pointer => { cursors.delete(pointer!); vt.xCursor.dispose(pointer!); return 0 },
      xBestIndex: guarded((_table, pointer) => {
        const info = vt.xIndexInfo(pointer!)
        try {
          info.$estimatedCost = request.to - request.from
          info.$estimatedRows = BigInt(request.to - request.from)
          for (let index = 0; index < info.$nConstraint; index++) {
            const constraint = info.nthConstraint(index)
            try {
              if (!constraint.$usable || ![0, -1].includes(constraint.$iColumn) || constraint.$op !== c.SQLITE_INDEX_CONSTRAINT_EQ) continue
              const usage = info.nthConstraintUsage(index)
              usage.$argvIndex = 1
              usage.$omit = 0
              usage.dispose()
              info.$idxNum = 1
              info.$estimatedCost = 1
              info.$estimatedRows = 1n
              break
            } finally { constraint.dispose() }
          }
        } finally { info.dispose() }
      }),
      xFilter: guarded((pointer, plan, _text, argc, argv) => {
        const state = cursor(pointer!)
        state.position = request.from
        state.end = request.to
        if (plan === 1 && argc === 1) {
          const value = c.sqlite3_value_to_js(w.peekPtr(argv!))
          if (typeof value === "number" && Number.isSafeInteger(value)) {
            state.position = Math.max(request.from, value)
            state.end = Math.min(request.to, value + 1)
          } else if (value === null) state.end = request.from
        }
        load(state)
      }),
      xNext: guarded(pointer => {
        const state = cursor(pointer!)
        state.position++
        if (state.position >= state.base + state.rows.length) load(state)
      }),
      xEof: pointer => cursor(pointer!).position >= cursor(pointer!).end ? 1 : 0,
      xColumn: guarded((pointer, context, column) => {
        const state = cursor(pointer!)
        c.sqlite3_result_js(context!, column === 0 ? state.position : state.rows[state.position - state.base]![column!])
      }),
      xRowid: guarded((pointer, output) => { vt.xRowid(output!, cursor(pointer!).position) }),
    } })
    sqlite.oo1.DB.checkRc(db, c.sqlite3_create_module(db.pointer, "journal_bridge", module, 0))
    db.exec("CREATE VIRTUAL TABLE events USING journal_bridge")
    db.exec("PRAGMA query_only=ON")
    for (const [name, kind, value] of [
      ["maxValueBytes", c.SQLITE_LIMIT_LENGTH, policy.maxValueBytes], ["maxColumns", c.SQLITE_LIMIT_COLUMN, policy.maxColumns],
      ["maxExprDepth", c.SQLITE_LIMIT_EXPR_DEPTH, policy.maxExprDepth], ["maxQueryChars", c.SQLITE_LIMIT_SQL_LENGTH, policy.maxQueryChars * 4],
    ] as const) {
      c.sqlite3_limit(db.pointer, kind, value)
      if (c.sqlite3_limit(db.pointer, kind, -1) !== value) throw new RuntimeError(`Unsupported SQLite query policy: ${name} ${value}`)
    }
    sqlite.oo1.DB.checkRc(db, c.sqlite3_set_authorizer(db.pointer, (_ctx, action, table, column) => {
      if (action === c.SQLITE_SELECT || action === c.SQLITE_RECURSIVE || action === c.SQLITE_READ && table === "events") return c.SQLITE_OK
      if (action === c.SQLITE_FUNCTION && functions.has(String(column).toLowerCase())) return c.SQLITE_OK
      return c.SQLITE_DENY
    }, 0))
    const progressEvery = Math.min(policy.progressEvery, policy.maxInstructions)
    c.sqlite3_progress_handler(db.pointer, progressEvery, () => (instructions += progressEvery) >= policy.maxInstructions ? 1 : 0, 0)
    const statement = prepareQuery(sqlite, db, request.sql)
    const columns: string[] = [], rows: Schema.Json[][] = []
    let more = false, resultBytes = 0
    try {
      statement.getColumnNames(columns)
      resultBytes = encoder.encode(JSON.stringify({ columns, rows: [] })).byteLength
      if (resultBytes > policy.maxResultBytes) throw new RuntimeError(`Query exceeds maxResultBytes ${policy.maxResultBytes}`)
      while (statement.step()) {
        if (rows.length === request.limit) { more = true; break }
        const values = statement.get([])
        const row: Schema.Json[] = []
        for (const value of values) {
          if (!(value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value))) throw new RuntimeError("Query result is not representable as JSON")
          row.push(value)
        }
        resultBytes += encoder.encode(JSON.stringify(row)).byteLength + (rows.length > 0 ? 1 : 0)
        if (resultBytes > policy.maxResultBytes) throw new RuntimeError(`Query exceeds maxResultBytes ${policy.maxResultBytes}`)
        rows.push(row)
      }
    } finally { statement.finalize() }
    if (failure) throw failure
    return { columns, rows, more, queryPolicy: { ...policy }, readEvents, readBytes }
  } catch (error) {
    if (failure) throw failure
    if (instructions >= policy.maxInstructions) throw new RuntimeError(`Query interrupted: maxInstructions ${policy.maxInstructions}`)
    throw new RuntimeError(`${String(error)} (queryPolicy ${JSON.stringify(policy)})`)
  }
  finally { db.close(); module?.dispose() }
}

// prepareQuery returns the validated statement with ownership of its native handle (test/scenarios/log-sql.ts, readOnlyLogSql).
function prepareQuery(sqlite: Sqlite, db: InstanceType<Sqlite["oo1"]["DB"]>, sql: string) {
  const c = sqlite.capi, w = sqlite.wasm
  const scope = w.scopedAllocPush()
  let pointer = 0
  try {
    let text = w.scopedAllocCString(sql)
    const [statementOut, tailOut] = w.scopedAllocPtr(2)
    while (text && w.peek8(text)) {
      w.pokePtr([statementOut, tailOut], 0)
      sqlite.oo1.DB.checkRc(db, c.sqlite3_prepare_v3(db.pointer, text, -1, 0, statementOut, tailOut))
      const next = w.peekPtr(statementOut)
      text = w.peekPtr(tailOut)
      if (!next) continue
      if (pointer) { c.sqlite3_finalize(next); throw new RuntimeError("Query requires exactly one statement") }
      pointer = next
    }
    if (!pointer) throw new RuntimeError("Query requires exactly one statement")
    if (!c.sqlite3_stmt_readonly(pointer)) throw new RuntimeError("Query requires a read-only statement")
    const statement = sqlite.oo1.Stmt.wrapHandle(db, pointer, true)
    pointer = 0
    return statement
  } finally {
    if (pointer) c.sqlite3_finalize(pointer)
    w.scopedAllocPop(scope)
  }
}
