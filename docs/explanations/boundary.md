A log is faithful when replaying it reproduces the run. That holds only while everything the run derived from is in the log. The boundary of the log is the line between what may come from the environment and what has to come from the log.

### Mechanism and information

Mechanism is how work runs: the sandbox, the HTTP client, the model binding. It lives in the platform layers, and replay stubs it.

Information is anything a transition derives from, or anything the model sees. It has to be reachable from the log you replay.

The test for a value is one question: if it changes, does the same log produce a different render or a different transition? Then it is information, and it belongs in the log. A value that fails the question is mechanism, and the environment may hold it.

Information that reaches the model from outside the log breaks replay quietly. Nothing errors. A fork re-renders a prompt nobody can reconstruct, and a diff between two variants measures the outside world along with the change.

### The three doors

Information enters through one of three doors.

1. Pin at read. An act reads the outside world and commits what it read as an event. Replay folds the event and reads nothing.
2. Delivery. The outside appends an event into the lane. The fact arrives as data, on the same footing as anything the agent did itself.
3. Pinned join. A projection joins another log at a watermark this log records. Replay reads that log's pinned prefix, never its present.

A reactor or a render that reads live external state, with nothing recorded and nothing pinned, is never sanctioned. It typechecks and it works in production, and it makes every fork after it a guess.

What the doors buy is determinism of the render: `renderOf(capabilities, log)` returns the same system prompt and the same tools for the same log, with no registry read, no clock, and no environment (packages/agent/src/capability.test.ts, "renderOf over one log is deterministic").

### Worked example: the package catalog

An agent's system prompt lists the packages its code can call. The catalog is information: change it and the model sees a different prompt.

The wrong way is for the platform to fetch the catalog at inference time and append it to the system prompt on the wire. The prompt then has two authors, and the second one leaves no trace. A fork of that log cannot reconstruct what the model was told, because the text came from a live cross-lane read that nothing pinned.

The chosen door is delivery. At lane creation the platform appends one `PackageInstalled` event per available package, in the same atomic batch as the lane's first event, and the catalog is a fold over the lane's own log. Builtins arrive as events like everything else, so a lane's capability surface is data in its log: remove the event from a forked log and the package leaves the render, with no platform change. The capability renders the block from that fold, so the prompt has one author.

### Choosing a door

Delivery fits a fact the outside knows at birth or pushes as it changes. Pin at read fits a fact an act discovers while doing its work, such as a fetched page or a resolved version. A pinned join fits a fact another log owns and keeps writing, where copying it would drift.
