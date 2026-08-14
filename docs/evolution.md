# Evolution

Evolution changes the code that constructs an agent. A candidate may rewrite module options, add a module, replace a machine, change orchestration, select another provider, or generate a new source file.

The framework supplies evaluation mechanics. It does not supply a proposer, mutation language, population model, or benchmark policy.

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

The default `AgentProgram.id` hashes ordered module manifests. Each manifest contains module id, version, and optional fingerprint.

Function source is excluded because closures do not have a stable portable representation. Code-generating systems should provide an explicit id from source control or build provenance. `parent` records lineage.

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

`paretoArchive()` is an optional algorithm-neutral utility for retaining candidates that trade off across tasks. It is not the package's search strategy.

## Search Algorithms

GEPA-style prompt search, source-rewriting agents, evolutionary program synthesis, self-play, and co-evolving populations can all consume the same candidate and rollout interfaces.

The field changes quickly, so algorithm policy remains outside the framework. Relevant examples include [GEPA](https://arxiv.org/abs/2507.19457), [code-writing harness optimization](https://www.cmpnd.ai/blog/let-the-model-write-the-code.html), and [PopuLoRA](https://vmax.ai/roger-creus/populora-co-evolving-llm-populations-for-reasoning-self-play).

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
