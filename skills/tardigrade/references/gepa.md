# Optimize a Tardigrade harness with GEPA

Use [GEPA](https://github.com/gepa-ai/gepa) to improve the text components of an actor from Tardigrade trajectories and evaluator feedback. GEPA is Genetic-Pareto, a reflective optimizer that diagnoses failures in natural language, proposes updates, and retains candidates that contribute to a Pareto frontier. Read the [GEPA paper](https://arxiv.org/abs/2507.19457) before changing the optimization loop.

## State the experiment

Write down the experiment before mutating the actor:

- The behavior to improve and the rubric that scores it.
- Development cases used during optimization and held-out cases used only for final selection.
- The task model, reflection model, evaluator, available packages, and environment shared by every candidate.
- The actor text components GEPA may change. Start with `actorInstructions`. Include other source text only when the user places it in scope.
- The maximum metric calls, time, or spend, plus any user-selected stop conditions.
- Constraints that no candidate may regress, including safety, permissions, output shape, latency, and cost.
- The improvement threshold required for promotion.

Every cap and threshold is part of the experiment record and can be changed by the user. GEPA requires `max_metric_calls` or an explicit stop callback. Do not invent a hidden budget or continue after the stated stopping condition.

Keep evaluation inputs, the rubric, and the evaluator outside the mutable candidate. Use repeated trials when model variance could change the result.

## Establish attribution

Build the current actor and retain its digest as the seed candidate. Give every proposed candidate a distinct actor name, such as `researcher-gepa-3`, then record its actor name, source revision, build digest, parent candidate, changed components, and trial thread IDs.

```bash
tdg build actor.ts
tdg push actor.ts --target local
tdg actors --json
```

Tardigrade runs do not record an immutable actor digest. Distinct candidate names and an external candidate table prevent a run from being attributed to source that replaced it later. Do not overwrite the seed actor during optimization.

Use a fresh, explicit thread ID for every trial:

```bash
tdg run "$brief" --actor "$candidate" --thread "$thread"
tdg events "$thread" --actor "$candidate" --json
```

Pass `--url` and `--token` when the experiment does not use the default local server. Push to a hosted target only when the user authorizes it.

## Build the reflective dataset

Create one GEPA example for each development case. Its rollout record contains:

- The input brief.
- The complete Tardigrade event trajectory.
- The final output or failure.
- The evaluator score for each declared objective.
- Natural language evaluator feedback that explains the score and identifies useful behavior or failure causes.

Read complete traces with `tdg events`. Use `tdg ls --actor "$candidate" --json` to recover a candidate's threads. The trajectory can include reasoning records, model attempts, generated code, package calls, tool results, budget events, and the final outcome. Redact secrets and sensitive tool output before sending a trajectory to an external reflection model.

Derive scores and feedback from the events that carry the relevant evidence:

- `TurnCompleted` and `TurnFailed` provide the output, failure cause, attempts, and applied policy.
- `ModelCalled` counts inference attempts. Consequence events contain usage when the provider reports it.
- `ToolCalled` and `ToolReturned` show tool choices, arguments, results, and failures.
- `CodeDispatched`, `PackageCalled`, `PackageReturned`, and `CodeSettled` show generated code, package traffic, errors, and captured logs.
- `BudgetExhausted`, `BudgetRequested`, `BudgetGranted`, and `BudgetDenied` show whether the actor reached or extended its work limit.
- Event timestamps provide latency when the runtime records it.

Give GEPA textual feedback alongside scalar scores. The reflection model uses the candidate text, trajectory, output, and feedback to assign credit and propose a revised component.

## Connect GEPA to Tardigrade

Use the official `gepa` package with a `GEPAAdapter` that maps its operations onto Tardigrade:

- `evaluate` writes the candidate components into an isolated actor source, builds it, pushes it under a distinct actor name, runs the selected cases, collects their event logs, and returns scores with textual feedback.
- Candidate text maps to the actor components declared mutable in the experiment.
- The seed candidate maps to the unchanged baseline components.
- The training set maps to development cases used for reflective updates.
- The validation set maps to cases used to maintain the Pareto frontier during optimization.

Set `reflection_lm` explicitly. Set `candidate_selection_strategy` and `frontier_type` explicitly so the experiment record shows how GEPA selects parents and tracks the frontier. Keep the GEPA defaults only when they are written into that record. Save `run_dir` so the optimization state, candidates, and logs can be inspected and resumed.

## Run the GEPA loop

GEPA performs the loop through its optimizer:

1. Select a candidate from the recorded Pareto frontier.
2. Evaluate it on a development minibatch and collect Tardigrade trajectories, scores, and textual feedback.
3. Ask the reflection model to diagnose the evidence and propose new text for an allowed actor component.
4. Build and push the proposal under a distinct actor name.
5. Evaluate the proposal and update the frontier when it improves one or more cases without violating a declared constraint.
6. Repeat until the stated metric-call budget or stop condition is reached.

Keep merge disabled unless the experiment explicitly enables it and records `max_merge_invocations`. When enabled, a merged candidate may combine lessons from complementary frontier candidates, but it still passes through the same build, trace, evaluation, and constraint checks.

## Validate and promote

After GEPA stops, evaluate its selected candidate and the unchanged seed against the held-out cases. Use the same evaluator and repeat count. Reject a candidate that improves only the development set, depends on one lucky trial, expands permissions, or crosses a declared constraint.

Before promotion, report:

- The selected actor name and build digest.
- The exact source diff from the seed.
- Development and held-out scores with trial counts.
- Relevant failures, model attempts, usage, tool calls, budget events, and latency.
- GEPA settings, experiment limits, and the stop condition that ended the run.
- Regressions, uncertainties, and cases the evaluation did not cover.

Promote the selected source under the intended actor name only after the user accepts the evidence. Rebuild it, verify the digest, push it to the authorized target, and retain the GEPA run directory and candidate table.
