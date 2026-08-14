# Evolution

Evolution changes the code that constructs an agent. A candidate can change modules, machines, orchestration, providers, and source files.

The framework supplies evaluation mechanics plus GEPA and PopuLoRA search loops. The caller supplies each mutation, evaluation policy, dataset, and budget.

## Candidate Values

```ts
const nextAgent = createAgent({
  id: "git:4f31c2a",
  parent: baseline.program.id,
  modules: buildCandidateModules()
})

const next = candidate(nextAgent.program.id, nextAgent, {
  parent: baseline.program.id,
  source: "src/candidates/4f31c2a.ts"
})
```

`Candidate<Value>` is generic. Search code can wrap an agent, source bundle, adapter population, compiler IR, or any other identified value.

## Program Identity

The default `AgentProgram.id` hashes ordered module manifests. Each manifest contains a module id, a version, and an optional identity value.

A module uses `identity` for behavior-affecting configuration, such as prompts, limits, provider state, and tool schemas. A module version identifies source-level behavior changes.

JavaScript closures have no stable portable representation. Code-generating systems can provide an explicit id from source control or build provenance. `parent` records lineage.

This keeps serializable metadata useful for provenance while allowing code to remain the primary evolutionary medium.

## Finite Observations

`observationOf(agent, log)` captures the pure surfaces available without running effects:

- rendered model request
- folded machine state and context
- declared observational projections

`observationallyEquivalent(left, right, logs)` compares those observations on a finite corpus. It is evidence over the supplied logs, not a proof over every possible input or external effect.

Finite equivalence is useful for program synthesis because differently structured programs can be treated as interchangeable on known cases.

## Forked Rollouts

```ts
const result = await rollout({
  baseline,
  candidate: nextAgent,
  log: recorded
})
```

The rollout checks the recording's program provenance, compares requests at recorded `ModelCalled` prefixes when the baseline matches, branches the candidate at the first divergence, and settles the live suffix. A provenance mismatch reuses no model calls.

`result.replayed` counts reused model calls. `result.called` counts live candidate calls. `result.log` is the independent branch log.

Changes to static instructions or tool descriptions usually diverge early. Changes to truncation can diverge later. Internal code changes that preserve every recorded request can reuse the full recording.

## Scoring and Selection

`scoreOf`, `spendOf`, and `verdictsOf` project evaluation facts from logs. Evaluators decide how those values are produced and combined.

`paretoArchive()` is an algorithm-neutral utility. It retains candidates that trade off across tasks.

## GEPA Search

`gepa()` implements the reflective-mutation loop from [GEPA](https://arxiv.org/abs/2507.19457). Its mutation unit is a complete `Candidate<Value>`.

```ts
const search = gepa({
  seed: baseline,
  feedbackExamples,
  paretoExamples,
  minibatchSize: 3,
  maxMetricCalls: 150,
  evaluate: (entry, example) => evaluateHarness(entry.value, example),
  mutate: ({ parent, trials }) => rewriteHarness(parent, trials)
})
```

The evaluator returns a numeric score and an arbitrary trajectory. The trajectory can contain logs, grader feedback, compiler output, or other evidence.

The mutation reads the parent and its feedback trials. It can replace the complete harness, including its modules, tools, machines, providers, and orchestration.

The loop uses these steps:

1. It scores the seed on every Pareto example.
2. It finds the best candidates for each Pareto example.
3. It removes dominated leaders and samples by the number of examples that each candidate leads.
4. It evaluates the selected parent on a random feedback minibatch.
5. It asks `mutate` for a new candidate and evaluates that candidate on the same minibatch.
6. It accepts a candidate when its average minibatch score is higher than its parent's score.
7. It scores each accepted candidate on every Pareto example.

The result contains the full population, the final frontier, iteration records, and the candidate with the highest Pareto average. GEPA records the selected parent on proposals that omit `parent`.

`maxMetricCalls` counts candidate-example evaluations. The loop starts an iteration when the remaining budget can score an accepted child on the full Pareto set.

The mutation can return `undefined` for an invalid construction. This permits compilation and runtime validation before candidate evaluation.

## PopuLoRA Search

`populora()` adapts the asymmetric self-play loop from [PopuLoRA](https://arxiv.org/abs/2605.16727v1) to whole-harness evolution. It keeps separate teacher and student populations. Each member is a complete `Candidate<Value>`.

GEPA searches one population against fixed examples. PopuLoRA searches problem-producing and problem-solving harnesses against each other.

```ts
const search = populora({
  teachers: teacherSeeds,
  students: studentSeeds,
  steps: 200,
  evolutionInterval: 10,
  cullFraction: 0.25,
  runMatch: ({ teacher, student }) =>
    evaluatePair(teacher.candidate.value, student.candidate.value),
  evolveTeacher: (context) => rewriteTeacherHarness(context),
  evolveStudent: (context) => rewriteStudentHarness(context)
})
```

The caller runs teacher generation, student attempts, and verification inside `runMatch`. It returns one `PopuloraTrial` for each generated problem. A trial contains verifier validity, student outcomes, and arbitrary evidence for later evolution. An invalid trial has no student outcomes. A valid trial has at least one outcome.

The loop applies the paper's rewards:

- An invalid teacher problem receives `-1`.
- A valid problem with no correct student outcome receives `0`.
- Any other valid problem receives `1 - solveRate`.
- A correct student outcome receives `1`.
- An incorrect, well-formed outcome receives `-0.5`.
- A format error receives `-1`.

Each search step follows these phases:

1. TrueSkill estimates the result of each possible teacher and student pairing.
2. PFSP samples near-balanced pairings with weight `p * (1 - p)`.
3. `runMatch` generates problems, collects student attempts, and verifies the results.
4. The aggregate solve rate is compared with its expected value. The result updates both TrueSkill ratings. A match with no valid problem is a student win.
5. At each evolution interval, the loop ranks each role by `mu - confidence * sigma`.
6. The loop replaces the lowest-ranked fraction through a mutation or crossover callback.

A mutation receives one top-ranked parent. A crossover receives two distinct top-ranked parents. Both callbacks receive the replaced member and all matches since the last evolution step. They can rewrite modules, tools, machines, providers, source files, and orchestration.

A callback can return `undefined` when it cannot construct a valid child. A new child starts with the configured initial TrueSkill rating. `PopuloraMember.parents` records every parent, while `Candidate.parent` records the primary parent.

The rating options use standard TrueSkill defaults. These include `mu = 25`, `sigma = 25 / 3`, `beta = 25 / 6`, `tau = 25 / 300`, and a draw probability of `0.1`. The lower-confidence multiplier defaults to `3`. `crossoverRate` defaults to `0.5`.

This adaptation uses harness mutation and crossover as the learning operation. It preserves the paper's teacher and student roles, verifier rewards, matchmaking, ratings, and population replacement policy.

The generic candidate and rollout interfaces also support source-rewriting search and evolutionary program synthesis. A related example is [code-writing harness optimization](https://www.cmpnd.ai/blog/let-the-model-write-the-code.html).

## Early Rejection

Generated candidates receive two validation layers:

1. TypeScript rejects missing services, duplicate service providers, and duplicate module ids for literal tuples.
2. Runtime compilation repeats those checks for generated JavaScript and rejects duplicate projections, machines, native tools, and instructions.

Search infrastructure can compile candidates first and avoid spending evaluation budget on invalid programs.

## Evaluation Loop

```text
choose parents
generate source candidates
compile and validate
compare finite observations
run forked rollouts only where requests diverge
score branch logs
select survivors
repeat
```

The event log is the evaluation record. A separate internal run-record abstraction is unnecessary.
