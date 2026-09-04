# Improve a prompt with NPO

Act as the optimizing agent. Apply [Naive Prompt Optimization](https://arxiv.org/abs/2608.27266) directly to the actor. NPO maintains one prompt lineage. A student model runs the current prompt, then a teacher model reads recent prompt versions, complete rollout traces, and rewards to produce the next version. Start with `actorInstructions`. Choose another method when the allowed change includes tools, control flow, or other harness code.

## Define the evaluation

Before editing the prompt, state:

- The behavior to improve.
- A development set and at least one held-out case.
- A scoring rubric with observable criteria.
- The student model that runs the actor and the teacher model that revises the prompt.
- The prompt text that may change.
- The minibatch size, rollout count per case, feedback window, and iteration count.
- Limits on total runs, time, model tokens, and cost.
- Constraints such as permissions, output shape, latency, and tool errors.
- The score or improvement required to promote a prompt.

The user can change every limit and threshold. If the user has not supplied them, propose visible values that fit the task. Keep the cases, rubric, student model, evaluator, and run settings fixed while comparing prompt versions. Use a documented seed or case order when the environment permits it.

Use deterministic checks when the output has a machine-readable contract. For subjective work, score each criterion from the evidence and record a short reason. Apply the same rubric to every rollout.

## Run the baseline

Build the unchanged actor, start `bun run dev`, and confirm its interface:

```bash
tdg build actor.ts
bun run dev
```

In another terminal:

```bash
tdg methods --json
```

Run every development case with a fresh thread ID, then read the complete event log:

```bash
tdg call message "$input" --thread "$thread" --json
tdg events "$thread" --json
```

Set `$input` to the method input JSON for the evaluation brief. Record the prompt, actor name, source digest, case scores, thread IDs, model usage, cost, and latency. Preserve the baseline actor during the search.

## Revise one lineage

Repeat this loop within the stated limits:

1. Select the next development minibatch using the fixed sampling rule.
2. Run the student model with the current prompt for the stated rollout count.
3. Record each complete trajectory and its rubric score.
4. Give the teacher the current feedback window. Include each prompt version, its trajectories, rewards, and score reasons.
5. Ask the teacher to explain the reusable lesson, preserve stated constraints, and return the complete next prompt without case answers.
6. Save the revision under a distinct actor name, record its parent and source diff, build it, and continue from that revision.

The feedback window contains the most recent prompt iterations up to the declared window size. NPO does not branch, merge candidates, or maintain a Pareto pool. Continue the single lineage until it reaches the iteration limit or another revision has no trace-supported hypothesis.

Keep secrets and sensitive tool output out of teacher requests. State whether the teacher is an external service before sending trajectories to it. Redact data in a way that preserves the evidence needed for scoring and revision.

## Validate and promote

Select the best prompt from development scores using the declared rule. Run that prompt and the unchanged baseline on the held-out cases. Report:

- The student and teacher models.
- The baseline and selected actor names and source digests.
- Every prompt revision and its parent.
- Development and held-out scores with reasons.
- Relevant failures, model calls, usage, tool errors, budget events, cost, and latency.
- The minibatch size, rollout count, feedback window, iteration count, and stop condition.
- Regressions and evaluation gaps.

Promote the selected prompt under the intended actor name after the user accepts the evidence. Rebuild it, verify the digest, and deploy it only to the authorized target.
