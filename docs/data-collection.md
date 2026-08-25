# Data collection tasks and review packets

## Product decision

Build a data collection platform where an admin defines a review task, loads input items, creates review packets, and gives each human labeler a unique URL. Labelers complete the assigned work in a focused interface, and the platform returns structured judgments with full provenance.

A task describes what the labeler sees, what actions they can take, what reasoning to collect, and what a valid submission contains. A collection job applies a versioned task to a specific dataset and policy. A review packet assigns a bounded set of job items through a secure URL.

Report calibration is the first task template. Its input is a human conversation, its model output is a title and key takeaways, and its label asks a person to approve or correct the report and explain why. Other tasks can use different inputs, controls, model steps, and output schemas while sharing packet delivery, voice capture, persistence, and export.

## Core concepts

| Concept | Contract |
| --- | --- |
| Task definition | A versioned review workflow with instructions, input schema, steps, components, output schema, and policy defaults |
| Collection job | One task version applied to a named dataset or set of raw items |
| Review item | One immutable source input inside a job |
| Review packet | An ordered assignment of review items with effective policy and access rules |
| Packet URL | A packet-scoped access capability used by one labeler or authenticated assignment |
| Submission | The labeler's saved decisions, reasoning, and provenance for one packet attempt |

Task definitions and source items are immutable after packet issue. A corrected task creates a new version. A corrected source creates a new item revision. Existing submissions continue to point to the exact versions their labelers saw.

## Roles

### Admin or orchestrator

The admin defines tasks, supplies data, previews the labeler experience, configures collection policy, generates packets, distributes links, monitors progress, handles revocation or reassignment, and exports results.

### Human labeler

The labeler opens an assigned packet, reads the task instructions, reviews only the packet's items, records decisions and reasoning, and submits the packet.

### Model service

A task can call a model to generate material for review or respond to a human correction. Model output remains a proposal until the task records a human decision. Each call records its model, prompt version, input revision, and output.

## Task definition

An admin starts from a trusted task template and configures the parts exposed by that template. The first templates use fixed components such as source viewers, section diffs, text editors, accept or edit or decline controls, single and multiple choice, evidence selection, free text, and voice reasoning.

```ts
interface TaskDefinition {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly instructions: string;
  readonly inputSchema: JsonSchema;
  readonly steps: ReadonlyArray<TaskStep>;
  readonly presentation: TaskPresentation;
  readonly outputSchema: JsonSchema;
  readonly defaultPolicy: TaskPolicy;
}
```

The admin can edit task instructions, map input fields, select enabled reasoning methods, configure supported decisions, choose a presentation, and set policy values. The platform validates the definition and renders a complete preview with sample data before it can issue a packet.

Task versioning covers every property that can change a judgment, including instructions, field mapping, model and prompt selection, step order, decision labels, validation, and policy defaults. A display-only correction that leaves meaning unchanged can still create a version so the audit history remains exact.

Arbitrary generated frontend code is outside the task system. A declarative definition selects audited components and supplies typed content. New interaction patterns enter the platform as reviewed components that existing and future tasks can reference by version.

## Task-specific generated interfaces

The admin can use [OpenUI](https://www.openui.com/docs/openui-lang/overview) to generate a task-specific presentation from the task instructions, input schema, output schema, workflow steps, and representative items. OpenUI composes registered components with typed properties, parses the result into an element tree, and validates it against the component library.

The platform provides a focused collection library rather than the full general-purpose component set. It includes full-width review workspaces, resizable input and output columns, source viewers, conversation messages, editable report sections, redlines, anchored annotations, evidence selections, decision groups, rationale fields, voice controls, progress, and submission summaries. Smaller task-specific libraries reduce ambiguity and make generated layouts easier to evaluate.

Generation happens while the admin authors or revises a task. The admin reviews the generated layout with sample items, checks desktop and mobile behavior, exercises every action, and approves an exact UI specification. Packet issue pins the approved specification, OpenUI language version, component library version, generating model, prompt version, and validation result.

Every labeler assigned to a presentation variant receives the same approved interface behavior. A collection job can compare several approved variants by assigning them explicitly and recording the variant on each submission. The model cannot change a packet's interface during review.

Generated components can emit only allowlisted task actions. The server validates each action against the task state, output schema, packet scope, and completion rules. Generated layout cannot mutate source data, invent a decision type, submit on the labeler's behalf, call an undeclared tool, or weaken packet access.

A task template can declare required layout invariants in its presentation schema. The report-calibration task requires a full-width two-column workspace with editable output on the left and immutable input on the right. OpenUI can arrange components inside those regions while validation rejects a presentation that hides either region behind a desktop tab or replaces the required comparison with a single-column flow.

If generation or validation fails, the task stays in draft and shows the error to the admin. Every task template also has a fixed baseline renderer that can preview and collect the same typed result. Fallback selection is an explicit presentation choice stored in the task and packet snapshots.

## Reference patterns

[Agentation](https://www.agentation.com/) demonstrates direct selection, feedback anchored to exact content, structured intent and priority, and a threaded lifecycle between a human and an agent. Review components apply the same pattern to report spans, conversation messages, model concerns, and labeler decisions. Each annotation keeps its target, author, status, reasoning, and replies as structured data.

[HUD](https://www.hud.ai/) demonstrates reusable templates, task runs at scale, result management, and QA that checks tasks and graders before weak signals enter training data. Collection jobs use the same separation between a reusable task definition, a run over selected items, quality checks, and downstream training or evaluation.

OpenUI supplies the generative presentation layer. The platform owns task semantics, permissions, state transitions, persistence, and validation. This boundary lets an admin create an interface suited to each task while every human label remains reproducible under a fixed contract.

## Loading review items

The admin can upload JSONL, paste a single raw item, or enter data through a task-specific form. API ingestion can use the same validation contract.

For JSONL, each non-empty line is one candidate item. The admin maps source fields to the task input schema, previews parsed records, and sees line-specific validation errors. Valid items can enter a job while invalid items remain excluded and downloadable as an error report.

Raw input follows the same task schema and produces the same immutable review item. A task can also create a model output from raw input before the item is eligible for packet assignment.

Source identifiers must be stable within a job. Duplicate identifiers fail validation unless the task explicitly defines a deduplication policy. The admin sees the selected policy and its effect before import.

## Collection jobs

A collection job snapshots:

- The exact task definition version.
- Admin instructions and project context.
- Imported item revisions and field mappings.
- Model and prompt versions used by task steps.
- Effective packet, assignment, review, and audio policies.
- Sampling reason for each selected item when an active learning sampler supplied the queue.

The admin can save a job as a draft, validate it, preview representative items, and issue packets. Issuing a packet freezes the relevant snapshot. Later job edits affect only packets created from the new snapshot.

## Packet generation

The admin selects eligible items and defines how the platform divides them into packets. The configuration exposes every value that affects labeler work:

- Number of items per packet.
- Item order or shuffle seed.
- Number of independent labels requested per item.
- Labeler assignment or anonymous link access.
- Expiration time and resume behavior.
- Whether an admin can reopen a submitted packet.
- Required decisions and reasoning fields.
- Effective audio retention policy.

The platform exports default packet policy, accepts job-level overrides, shows the effective values before issue, and stores them with every packet. Packet size, overlap, expiration, and completion rules cannot be hidden constants.

Packet generation is deterministic for a saved configuration and seed. The preview shows which items enter each packet and flags accidental overlap, missing coverage, or assignment conflicts. The admin confirms issue as a separate action.

## Unique packet URLs

Each issued packet receives a unique, high-entropy access token. The token grants access only to that packet and reveals no source identifier, labeler identity, or dataset content in the URL.

The server stores a token hash. On first use, the application exchanges the URL token for a packet-scoped, secure, HTTP-only session and removes the secret from the visible URL. Packet pages send a restrictive referrer policy, and analytics or logs cannot capture access tokens or source content.

The admin chooses one access mode:

- Assigned access requires the intended labeler to sign in.
- Capability-link access allows anyone holding the link to review the packet and clearly warns the admin about link sharing.

An admin can revoke an issued URL, set or change expiration for unused packets, and create a replacement assignment. Revocation ends new and active packet sessions. A replacement packet receives a new token and preserves the audit relationship to the earlier packet.

Packet lifecycle is explicit: `draft`, `issued`, `in-progress`, `submitted`, `expired`, or `revoked`. Reopening a submitted packet creates a new attempt linked to the prior submission. It never overwrites the submitted result.

## Labeler experience

The packet landing page shows the task name, task instructions, item count, expected completion rule, effective audio policy, and any consent or confidentiality notice. The labeler accepts the terms before source content appears when the job requires consent.

The review interface shows packet progress and the current item. It autosaves draft answers, provides a clear save state, and restores the exact draft after reload. The labeler can access only items in the active packet.

Task components guide the work without hiding source material used for judgment. Model suggestions display their model provenance and remain visually distinct from human-authored text. Voice transcripts remain editable before submission.

The final screen summarizes unanswered requirements and validation errors. Submission requires an explicit confirmation. The receipt shows a non-secret packet reference and submission time without exposing another labeler's work.

## Admin dashboard

The admin dashboard groups work by task and collection job. It shows item coverage, packet state, labeler assignment, last activity, completion time, validation failures, and expired or revoked access.

The admin can inspect a submission with the same task version and source snapshot seen by the labeler. Corrections to administration metadata remain separate from labeler output. Reassignment, revocation, reopening, and export produce audit events.

The dashboard can export completed submissions, incomplete drafts when policy allows, packet metadata, and provenance as JSONL. Export keeps the task-specific result under its declared output schema and adds a platform envelope for job, packet, item, attempt, labeler, timing, and policy fields.

## Submission contract

```ts
interface ReviewSubmission<Result> {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly jobId: string;
  readonly jobSnapshot: number;
  readonly packetId: string;
  readonly packetAttempt: number;
  readonly itemId: string;
  readonly itemRevision: number;
  readonly labeler: LabelerRef | "capability-link";
  readonly result: Result;
  readonly effectivePolicy: TaskPolicy;
  readonly startedAt: number;
  readonly submittedAt: number;
}
```

The task-specific `result` preserves all revisions and reasoning needed by that task. The platform envelope makes results attributable and reproducible across packet strategies and task versions.

## Active learning integration

An active learning sampler can provide item identifiers and a selection reason to a collection job. The admin reviews the proposed queue before packet issue or enables a versioned automatic-issue policy. The job stores the sampler version, scores, thresholds, and human-readable reason for every selected item.

Human submissions return to the labeled pool only after the task's completion rule passes. Model proposals, incomplete drafts, and expired packets retain their own states and cannot silently become human labels.

The platform can support later tasks for failure-mode confirmation, pairwise comparison, rubric scoring, evidence selection, or preference ranking by adding task definitions and trusted components. Packet security, assignment, voice capture, persistence, and provenance remain shared infrastructure.

## Product boundary

The first platform slice includes:

- Versioned task definitions built from trusted components.
- OpenUI generation, validation, preview, and pinning for task-specific presentations.
- JSONL and raw-item ingestion with schema validation and preview.
- Collection jobs with explicit policy snapshots.
- Deterministic packet generation and unique packet URLs.
- Assigned and capability-link access modes.
- Resumable labeler drafts and explicit submission.
- Admin progress, revocation, reassignment, reopening, and export.
- Text and editable voice reasoning.
- Full-width comparison workspaces with editable output and accessible redlines.
- The report-calibration task described in [report-calibration.md](report-calibration.md).

The first platform slice excludes:

- Arbitrary task code supplied through the admin interface.
- Interface changes generated during an active labeler review.
- Payment, recruiting, and labeler marketplace features.
- Automatic model training or deployment.
- Automatic approval of model-generated labels.
- Cross-organization data sharing.

## Acceptance criteria

- An admin can create and preview a versioned task from trusted components.
- An admin can generate a task presentation through OpenUI, validate every component and action, approve a fixed specification, and identify its complete generation provenance.
- An admin can upload JSONL or add a raw item and see field-level validation before import.
- An admin can configure packet size, overlap, order, access, expiration, completion, and audio policy without code changes.
- Packet preview accounts for every selected item and shows duplicate assignments.
- Each issued packet has a unique revocable URL scoped to its assigned items.
- A capability token is absent from stored plaintext, application logs, analytics, and the visible URL after exchange.
- A labeler can read instructions, complete assigned items, record text or voice reasoning, resume a draft, and submit explicitly.
- Labelers assigned to the same presentation variant receive the same pinned interface and server-validated decision contract.
- A task can require persistent side-by-side regions, editable output, and redline behavior as validated presentation invariants.
- A labeler cannot read an item from another packet through the packet session.
- An admin can monitor packet states, revoke or replace access, reopen a submission as a new attempt, and export results.
- Every exported result identifies the task, job snapshot, packet attempt, item revision, labeler authority, model provenance, and effective policies used during review.
