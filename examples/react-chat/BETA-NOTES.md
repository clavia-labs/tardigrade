# React chat beta notes

This file is a running list of problems, surprises, and follow-up work found while building and testing the React chat example. Add new entries at the end of the relevant section.

## Setup and development

### The example needed an explicit workspace entry

- Symptom: Bun did not treat `examples/react-chat` as a workspace package.
- Cause: The existing workspace patterns did not include the nested example.
- Resolution: Add `examples/react-chat` to the root `workspaces` array.

### The default CLI UI was unavailable

- Symptom: Starting the actor through the CLI failed while looking for Voyager assets.
- Cause: The local development command expected a built default UI.
- Resolution: Build the React app first and pass `--ui dist` to the CLI. The `agent` script now performs both steps.

### Two development servers caused confusion

- Symptom: The app opened on Vite port 5173, while calls expected the actor on port 4242. Sending a message appeared to do nothing when only the UI server was available.
- Cause: Vite served the browser bundle and the Tardigrade CLI served the actor API.
- Resolution: Use `bun run --cwd examples/react-chat agent` for the integrated app at `http://localhost:4242`. A separate Vite server is useful only while the actor server is also running.

### UI changes require a fresh static build

- Symptom: A reload continued to request an older hashed JavaScript or CSS asset.
- Cause: The actor serves the files already written to `dist`.
- Resolution: Run the build again before checking the integrated app, then reload port 4242.

### The production build opens a temporary port

- Symptom: The Web build failed with `EPERM` while binding to `::1:3000` in the sandbox.
- Cause: TanStack Start uses a temporary local server during prerendering.
- Resolution: Allow the build to open its local prerender port. The build passed after that permission was granted.

### The example server needs host permission

- Symptom: Restarting the example reported that it failed to listen on `127.0.0.1` even though no process owned port 4242.
- Cause: The restricted command environment could not bind a local listening socket.
- Resolution: Run the example server with approved localhost access. Verify it from the same host environment.

### The client bundle is larger than Vite's default warning threshold

- Symptom: Vite reports a chunk larger than 500 kB after minification.
- Cause: The deliberately simple example currently bundles its UI and client dependencies into one entry chunk.
- Resolution: None yet. Keep the warning visible and consider code splitting only if the example grows.

## Models and credentials

### OpenRouter needed generated local configuration

- Symptom: The actor had no configured model provider.
- Cause: The example needed provider metadata, a model selection, and a local credential.
- Resolution: The CLI generated `wrangler.jsonc` and `models.lock.json`. The secret lives in the ignored `.dev.vars` file.

### A credential was pasted into the conversation

- Symptom: The OpenRouter key became visible in chat history.
- Cause: The key was supplied directly during setup.
- Resolution: Rotate the exposed key. Keep its replacement in `.dev.vars` and never commit or copy it into documentation, logs, screenshots, or source files.

### Generated model metadata is large and provider-specific

- Symptom: `models.lock.json` adds a large generated file to the example.
- Cause: The lock records the provider catalog used by local inference.
- Resolution: Decide whether the example should commit a small reproducible model lock or document the setup command before the branch is merged.

## Browser testing

### Chrome automation was unavailable

- Symptom: The requested Chrome control could not open or inspect the app.
- Cause: No browser surface was connected to the computer-use session. Direct Safari control also lacked operating-system permission.
- Resolution: Visual checks relied on manual reloads and screenshots. Connect a supported browser surface before automated visual regression work.

## Event rendering

### The durable browser stream has no token chunks

- Symptom: The UI could show inference start, though it could not identify the literal first streamed token.
- Cause: The durable event stream exposes committed events such as `ModelCalled`, `TextReturned`, `ToolCalled`, and terminal turn events.
- Resolution: Show the waiting indicator after `ModelCalled` and remove it at the first committed response boundary.

### Tool activity was filtered out of the transcript

- Symptom: Code execution happened without any visible status.
- Cause: The transcript originally rendered only inbound messages and terminal turn events.
- Resolution: Render `ToolCalled` in sequence order and pair it with `ToolReturned` through `callId`. Show a spinner while open and a collapsed disclosure after completion.

### Tool arguments are structurally open

- Symptom: A renderer cannot assume every tool call contains source code.
- Cause: `ToolCalled.arguments` is an unknown value by contract.
- Resolution: Read `arguments.code` for the `execute` tool and fall back to formatted JSON for other tools.

### A tool call temporarily replaces the model waiting state

- Symptom: The three-dot model indicator disappears when a tool begins.
- Cause: `ToolCalled` is a committed response boundary, and the turn is waiting on the tool instead of the model at that point.
- Resolution: Let the tool row carry the active spinner. A later `ModelCalled` restores the model waiting indicator for the next inference attempt.

## Subagent threads

### Subagents require an explicit package

- Symptom: Code mode alone did not expose subagent tools.
- Cause: Agent spawning is provided by `agentsPackage()`.
- Resolution: Mount `agentsPackage()` beside `filesPackage()` in the actor's code-mode configuration.

### Thread listing order is not transcript order

- Symptom: Rendering child threads from `client.list()` placed every subagent action after the whole conversation.
- Cause: The thread list describes current topology and status. It does not describe where a child was created in its parent's event sequence.
- Resolution: Render a “Subagent” action at the parent's durable `ChildCreated` event. This places it after the spawning call and before the parent reply.

### Internal and public child IDs differ

- Symptom: Opening an inline child requested `ag.call_…` and returned 404, while the public list exposed `call_…`.
- Cause: `ChildCreated.address.thread` carries the internal `ag.` prefix. The HTTP API strips that prefix from thread resource IDs.
- Resolution: Use the `ChildCreated.callId` as the public child ID for this package-generated sibling thread.

### The empty state hid the bad child request

- Symptom: A failed child lookup appeared as “Waiting for the subagent.”
- Cause: The event reader intentionally converts a 404 into an empty event array so a new root thread can begin before it exists.
- Resolution: Fix child ID resolution and use precise side-panel states: “Loading thread…” while fetching and “No messages in this thread.” after an empty response.

### Subagent visualization did not exist in the original UI

- Symptom: Durable child threads were available through the client, though the example had no way to discover or inspect them.
- Cause: The first pass rendered only the selected root thread.
- Resolution: Follow actor thread additions, render `ChildCreated` actions inline, and open the selected child in a side panel. Apply the same transcript renderer inside that panel so nested children remain discoverable.

### The side thread was read-only

- Symptom: A user could inspect a child thread and could not continue its conversation.
- Cause: Only the root surface rendered a message composer.
- Resolution: Reuse one composer component for root and child threads. Send directly to the selected child's durable `message` method and keep its draft, pending state, and errors independent.

### Adjacent child rows became repetitive

- Symptom: A parallel spawn rendered several identical “Subagent” rows with separate full-height timeline borders.
- Cause: Each `ChildCreated` event rendered as an independent action.
- Resolution: Group adjacent child creation events into one collapsed tree at the first event's position. Use compact Phosphor icons and numbered child actions inside the tree.

### The subagent tree looked like a sibling of execution

- Symptom: The execution row and its spawned subagents shared the same left edge.
- Cause: Event order was correct, though the visual hierarchy did not express that the code created the subagents.
- Resolution: Inset the subagent tree beneath the execution row while keeping it visible when the code disclosure is closed.

## Styling

### Importing a theme did not theme the chat

- Symptom: The example imported Tardigrade Web tokens while its appearance remained controlled by local hex values.
- Cause: Component styles still contained literal colors.
- Resolution: Add a semantic `--ui-*` contract and replace the chat's literals with those variables.

### Geometry was missing from the shared theme

- Symptom: Shared colors made the chat feel related to Web, while its large radii still felt much softer.
- Cause: Web's sharp geometry lived as local `2px` and `3px` values.
- Resolution: Export panel, control, message, and round radius values from the theme and consume their semantic aliases in the chat.

### Web geometry felt too sharp for a consumer chat

- Symptom: The shared `2px` geometry made the example feel like a developer console.
- Cause: Tardigrade Web and a consumer conversation surface need different shape defaults.
- Resolution: Keep the sharp Web theme and add a consumer theme that inherits its colors and typography. The chat switches themes through one CSS import and receives rounder messages, controls, panels, and softer shadows.

### The consumer accent was too bright

- Symptom: Tardigrade Web's saturated blue dominated the conversation surface.
- Cause: The consumer theme inherited the Web accent without adapting its intensity.
- Resolution: Give the consumer theme a pale slate-blue accent with dark foreground text. Replace branch glyphs with Phosphor robot icons so subagents read as actors while connector lines continue to show hierarchy.

### The pastel accent leaned purple

- Symptom: The first muted accent still read as periwinkle, and assistant bubbles carried a visible outline.
- Cause: The accent mixed too much red into the blue and retained the earlier bordered message treatment.
- Resolution: Shift the consumer accent to powder blue and remove the assistant-bubble border. Keep the composer border as the input boundary.

### Theme font names do not load font files

- Symptom: The example may render system fallbacks even though it uses the shared font variables.
- Cause: The shared theme declares font families and does not distribute or load their font assets.
- Resolution: Decide whether the UI package should ship font loading, document an application-owned font setup, or embrace the system fallback for this example.

### The shared UI package is internal

- Symptom: Web and the example can resolve `@clavia/tardigrade-ui` in the workspace, though external consumers cannot install it.
- Cause: The new package is private and absent from the release staging flow.
- Resolution: Decide whether the theme package is an internal workspace boundary or a public package before documenting it as a consumer API.

## Public example readiness

### The client import is workspace-specific

- Symptom: The example imports `@clavia/tardigrade-client`, which works inside this repository.
- Cause: The browser client is an internal workspace package here.
- Resolution: Confirm the supported public import, expected to be `tardie/client`, before publishing the example for issue 359.

### The README run instructions have drifted

- Symptom: The README says to start both the integrated actor command and a separate Vite server, then open port 5173.
- Cause: The `agent` script later gained the `--ui dist` integrated flow on port 4242.
- Resolution: Rewrite the README after the beta workflow settles so it describes one supported path.

## Live inference

### Durable SSE did not carry provider chunks

- Symptom: The interface showed a waiting indicator until the complete assistant response arrived.
- Cause: The durable event stream publishes committed log events. Provider text deltas exist only in the process-local inference observer.
- Resolution: Add a transient server SSE route and `followInference` client helper. Keep terminal durable events authoritative and discard a partial preview when a sequence gap is detected.

### A thread name did not identify an actor instance

- Symptom: Filtering live output by internal thread alone could mix two actor instances that used the same thread ID.
- Cause: Inference identity carried the actor definition and thread, though the public route addresses an actor instance.
- Resolution: Add `instance` to inference identity and filter each SSE connection by actor instance and public thread ID.

### The subagent icon felt mechanical

- Symptom: Robot icons made the compact child tree read like infrastructure instead of a friendly conversation.
- Cause: The first tree treatment used the most literal agent glyph.
- Resolution: Use Lucide's compact worm glyph as the subagent mark. Keep Phosphor for the rest of the interface.

### The collapsed child count was wordy

- Symptom: The compact tree repeated “subagent” beside an icon that already communicated the concept.
- Cause: The summary used a sentence-style count.
- Resolution: Show the worm mark with `x1 subagent`, `x3 subagents`, and similar counts. Keep the numbered child names in the expanded tree.

### The composer scrolled away

- Symptom: A long conversation pushed the message input below the viewport.
- Cause: The root shell used a minimum viewport height and allowed the transcript to grow the page.
- Resolution: Bound each conversation panel to the dynamic viewport and scroll only its transcript. Keep the composer in the panel's fixed bottom row.

### The top controls floated over messages

- Symptom: The history and new-thread controls stayed near the top, though the root chat had no fixed header area.
- Cause: The controls used absolute positioning over the transcript.
- Resolution: Give the root panel a fixed header row with a quiet divider and right-aligned controls. Keep the left side empty and scroll only the transcript below it.

### The transcript scrollbar was inset

- Symptom: The scroll track appeared at the right edge of the centered conversation instead of the page.
- Cause: The scroll container lived inside the shell's horizontal padding.
- Resolution: Make the root shell span its panel and place horizontal spacing on each child. Keep message content centered while the transcript scroll track sits at the panel's right edge.

### Fixed rows kept a floating gutter

- Symptom: Empty space remained below the header divider and above the composer after both became fixed rows.
- Cause: The shell kept the earlier `20px` grid gap between every row.
- Resolution: Remove the row gap so the transcript meets both fixed surfaces directly. Keep spacing between individual messages inside the transcript.

### Edge bubbles needed breathing room

- Symptom: Removing the shell gap left the first and last bubbles too close to the fixed surfaces.
- Cause: The transcript had no vertical content inset of its own.
- Resolution: Add equal `16px` padding above the first bubble and below the last bubble inside the scroll area.

### Root and child headers missed alignment

- Symptom: The root divider sat `4px` below the subagent divider.
- Cause: The root used `24px` outer top padding plus a `44px` header while the subagent header was `64px` tall.
- Resolution: Remove the root's separate top padding and use the same `64px` header height for both panels.

### Threads hid behind a popover

- Symptom: Switching conversations required opening a history menu before seeing any threads.
- Cause: The first navigation treatment optimized for an empty header instead of persistent conversation access.
- Resolution: Move root threads into a fixed left sidebar with compact timestamp rows and an active state. Put new-thread creation in the sidebar header and use an icon-only rail on narrow screens.

### The thread sidebar felt structural

- Symptom: The full-height sidebar read like an application frame instead of a light conversation control.
- Cause: It touched every viewport edge and used a single dividing border.
- Resolution: Inset the sidebar from the viewport, round the complete panel, and use a restrained border and shadow. Reduce its inset on narrow screens.

### One malformed thread blocked the list

- Symptom: The sidebar stayed on “Loading…” while the active conversation still worked.
- Cause: An earlier beta opened an internal `ag.*` child address as a public thread ID. The stored thread lacked the required first `ThreadCreated` event, so the tree projection rejected the complete thread list with a `500` response.
- Resolution: Stop the example and clear its beta actor state. Move the old `.tardigrade` directory to `/private/tmp/react-chat-actor-state-before-clear` so it remains recoverable during this session.

### The floating sidebar was too stark

- Symptom: The tall white thread panel dominated the warm conversation canvas.
- Cause: The sidebar used the primary surface color across most of the viewport.
- Resolution: Blend the primary and muted surface colors for the sidebar and use the pale accent wash for the active thread. Using only the muted surface made the panel too dark.

### New messages stayed at the bottom

- Symptom: Sending a message left the new user bubble near the composer instead of starting the turn at the top of the transcript.
- Cause: The transcript had no send anchor or space below the current turn.
- Resolution: Record the last durable user sequence in the mutation's `onMutate` callback, then scroll the next durable user event to the top and reserve reply space beneath it. Use the browser scroll behavior because this small transcript does not need TanStack Virtual.

### Exact optional props rejected undefined

- Symptom: TypeScript rejected an optional transcript anchor when its caller passed `number | undefined`.
- Cause: `exactOptionalPropertyTypes` distinguishes a missing property from a property whose value is `undefined`.
- Resolution: Make the anchor property required and declare its value as `number | undefined`.

### Package calls looked like generic tools

- Symptom: A transcript row did not make the called package and method clear.
- Cause: Every non-execution tool used one generic label and the code icon. The first fix still filtered out `PackageCalled` events because it only rendered `ToolCalled` events.
- Resolution: Render `PackageCalled` with its matching `PackageReturned` event, split names such as `fetch.get` into a package and method label, show a package icon, and preserve the expandable arguments. Mount `fetchPackage()` in the example so the agent can make HTTP requests.

### Result collection looked like separate work

- Symptom: Spawning five subagents showed one completed execution, a five-child tree, and another execution spinner.
- Cause: The first execution dispatched background children and completed. The model then made a second execution that called only `agents.result` and waited for their replies.
- Resolution: Keep the child tree under the dispatching execution, show its spinner while child replies remain, and hide an execution whose package calls only collect those results.
