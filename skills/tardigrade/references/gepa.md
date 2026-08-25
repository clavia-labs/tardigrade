# Improve a harness with GEPA

Act as the optimizing agent. Apply the [GEPA](https://github.com/gepa-ai/gepa) method directly to the actor. You do not need DSPy, the Python package, or a separate adapter. Read run trajectories, score them against a fixed rubric, reflect on failures in natural language, and evolve the text in `actor.ts`.

## Define the evaluation

Before editing the actor, state:

- The behavior to improve.
- A small set of development cases and at least one held-out case.
- A scoring rubric with observable criteria.
- The actor text that may change. Start with `actorInstructions` unless the task requires a wider harness change.
- Limits on candidate runs, time, and cost.
- Constraints such as permissions, output shape, latency, and tool errors.
- The score or improvement required to promote a candidate.

The user can change every limit and threshold. If the user has not supplied them, propose visible values that fit the task. Keep the cases, rubric, and evaluator fixed while comparing candidates.

Use deterministic checks when the output has a machine-readable contract. For subjective work, score each criterion from the evidence and record a short reason. Apply the same rubric to every candidate.

## Run the baseline

Build the unchanged actor, start `tdg dev`, and record its name and digest:

```bash
tdg build actor.ts
tdg dev
```

In another terminal, confirm the served actor's interface:

```bash
tdg methods --json
```

Run every development case with a fresh thread ID, then read the complete event log:

```bash
tdg call message "$input" --thread "$thread" --json
tdg events "$thread" --json
```

Set `$input` to the method input JSON for the evaluation brief. Each candidate runs from its own actor directory, so local commands use the mounted actor without `--actor`.

Score the final output and relevant trace behavior. Inspect tool errors, retries, model calls, budget events, and latency when they affect the rubric or constraints. Keep secrets and sensitive tool output out of reports and external model calls.

Tardigrade runs do not record an immutable actor digest. Give each candidate a distinct actor name, such as `researcher-gepa-2`, and record its name, parent, source diff, digest, scores, and thread IDs. Preserve the baseline actor during the search.

## Evolve the actor

Repeat this GEPA loop within the stated limits:

1. Select a candidate from the Pareto frontier of recorded case scores.
2. Read its weakest or most informative trajectories.
3. Explain which instruction or harness choice caused the observed behavior.
4. Propose a focused change to the allowed actor text.
5. Build the proposal under a distinct candidate name, then restart `tdg dev` from its directory.
6. Run the same development cases and score them with the same rubric.
7. Retain the proposal when it improves at least one case without regressing another case or violating a constraint.

The reflection should turn trace evidence into a reusable instruction. Avoid copying an answer from one evaluation case into the actor. When two frontier candidates contain complementary lessons, combine those lessons in a new candidate and evaluate it through the same loop.

Stop when a candidate reaches the promotion threshold, the experiment reaches a stated limit, or another iteration no longer has a trace-supported hypothesis.

## Validate and promote

Run the surviving candidates and the unchanged baseline on the held-out cases. Report:

- Candidate names and build digests.
- The source diff from the baseline.
- Development and held-out scores with reasons.
- Relevant failures, model calls, usage, tool errors, budget events, and latency.
- The limits and stop condition.
- Regressions and evaluation gaps.

Promote the selected source under the intended actor name after the user accepts the evidence. Rebuild it, verify the digest, and deploy it only to the authorized target.
