// journalMigration checks staged SQL/KV conversion, admission, retention and crash recovery (test/workerd/migration.workers.ts).
// SQLite and DO transactions commit atomically; authentication rejects invalid sources before publication.
// Inputs, references and log records are finite symbols; hashing, node codecs and TypeScript refinement are outside this model.
module journalMigration {
  type State = {
    log: List[int], oldSql: bool, newSql: bool, oldKv: bool, newKv: bool,
    stage: int, checked: bool, valid: bool, active: bool, input: int,
    proposal: int, executed: Set[(int, int)], earlyDrop: bool, earlyAdmission: bool,
  }
  pure def initial(earlyDrop: bool, earlyAdmission: bool): State = {
    log: List(10, 20, 30), oldSql: true, newSql: false, oldKv: true, newKv: false,
    stage: 0, checked: false, valid: true, active: true, input: 0,
    proposal: 1, executed: Set(), earlyDrop: earlyDrop, earlyAdmission: earlyAdmission,
  }
  var state: State
  action init = { state' = initial(false, false) }
  action initCorrupt = { state' = { ...initial(false, false), valid: false } }
  action initEarlyDrop = { state' = initial(true, false) }
  action initEarlyAdmission = { state' = initial(false, true) }

  action stageSql = all {
    state.oldSql, state.stage == 0,
    state' = { ...state, stage: 1, checked: state.valid },
  }
  action commitSql = all {
    state.stage == 1, state.checked,
    state' = { ...state, oldSql: false, newSql: true, input: 1, stage: 0, checked: false },
  }
  action stageKv = all {
    state.newSql, state.oldKv, state.stage == 0,
    state' = { ...state, stage: 2, checked: state.valid },
  }
  action commitKv = all {
    state.stage == 2, state.checked,
    state' = { ...state, oldKv: false, newKv: true, stage: 0, checked: false },
  }
  action rollback = all {
    state.stage != 0,
    state' = { ...state, stage: 0, checked: false },
  }
  action crash = { state' = { ...state, stage: 0, checked: false, proposal: 2 } }
  action execute = all {
    state.active, or { state.earlyAdmission, and { state.newSql, state.newKv } },
    state' = { ...state, executed: state.executed.union(Set((7, state.input))) },
  }
  action acknowledge = all {
    state.executed.contains((7, 1)), state.active,
    state' = { ...state, active: false },
  }
  action collect = all {
    not(state.active),
    state' = { ...state, input: 0 },
  }
  action dropEarly = all {
    state.earlyDrop, state.oldSql,
    state' = { ...state, oldSql: false },
  }
  action step = any { stageSql, commitSql, stageKv, commitKv, rollback, crash, execute, acknowledge, collect, dropEarly }

  val logUnchanged = state.log == List(10, 20, 30)
  val sourceAvailable = and { or { state.oldSql, state.newSql }, or { state.oldKv, state.newKv } }
  val retainedInput = implies(state.active, or { state.oldSql, state.input == 1 })
  val verifiedExecution = state.executed.forall(call => call == (7, 1))
  val corruptNotAdmitted = implies(not(state.valid), state.executed == Set())
  val invariant = and { logUnchanged, sourceAvailable, retainedInput, verifiedExecution, corruptNotAdmitted }
}
