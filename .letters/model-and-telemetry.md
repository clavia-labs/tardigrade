---
slug: model-and-telemetry
from: claude-fable-5
date: 2026-08-19 05:59 SGT
context: the Aug 18-19 session that reabsorbed the removed driver's behaviors into platform/model and built the tracing story
audience: the next agent working in tardigrade (or wiring v6 to it)
---

This letter is from the session that ported Henry's driver lessons onto the TanStack binding, built the span pass with cross-lane trace linking, and survived the repo changing its Effect major, its package scope, and its name underneath the work.

## Your local environment lies until you clean it

My typechecks passed for hours against a stale node_modules holding effect 4.0.0-rc.108 from the pre-swap era while the lockfile said 3.22.1, and then the repo genuinely moved to 4.0.0-rc.110 (#53) and the same staleness lied in the other direction. Before trusting any local check here: rm -rf node_modules packages/*/node_modules platform/*/node_modules, bun install, and read node_modules/effect/package.json. CI is the arbiter; when CI and local disagree, local is the liar.

## Arjun merges in seconds

Five commits stranded on merged branches in one session, one of them twice in a row. Treat every PR as merged the moment you open it. A follow-up, however small, goes on a fresh branch cut from freshly fetched origin/main. Recovery is mechanical: cherry-pick the stranded commit (no -q flag exists), fresh branch, fresh PR. The auto-memory has this rule; believe it harder than I did.

## platform/model is canonical and v6's copy is now an orphan

Everything this session built lives here: Retry-After honored (#38), truncation fails loudly up a token ladder (#39), declared output limits (#41), a fresh idempotency key per ladder rung (#42), wide llm.react spans. v6's apps/api/src/platform/model.ts has NONE of it: prod runs the old byte-twin. The queued fix is retiring that file into the vendored @tardigrade/model; until then every change here widens a divergence prod does not know about. v6's submodule pin is also several merges behind and its .gitmodules still says flamework (redirects hold).

## The truncation design is research-backed; do not resurrect the nudge

The industry consensus (sources in #39's body): a response cut at the output ceiling is a failed attempt, never an answer; retry with a higher ceiling; no mainstream framework continues a cut tool call, and the one that auto-continues prose removed the feature. Henry's nudge-continuation design was considered and rejected on that evidence. The remaining Henry items are issues #45 (gateway routes), #46 (continuations tripwire: jumps the queue when a Gemini-class model enters), #47 (spend reservation: blocked on the authority-above-the-seam decision).

## The telemetry contracts are normative, and v6 will violate them by default

docs/how-to/observe.md states the two contracts a trace reader cannot discover: every platform binding stamps the sending span's context onto each persisted event (one traceparent string, first stamp wins) or cross-lane traces silently fragment, and transition.fire links to the newest carried context as "the delivery that woke this work", an approximation by design. When v6's Cloudflare platform consumes these packages it must add the same stamp in its deliver and drop the root: true on door.through, or prod traces stay fragmented while looking instrumented.

## Effect v4 gotchas paid for this session

SpanLink lost its _tag. Tracer.make's span hook takes one options object. Layer.setTracer is gone; provide with Layer.succeed(Tracer.Tracer)(tracer). Span.annotations replaced Span.context, and a fake span with the wrong field crashes deep in Context internals (impl.overlay undefined) far from the cause. The OTLP exporter is IN CORE now (effect/unstable/observability/Otlp, HttpClient from unstable/http), which is why platform/bun/src/otlp.ts has zero dependencies; @effect/opentelemetry is unnecessary here, and @effect/sql was absorbed into core too.

## The quickstart is verified-runnable; here is how to verify it again

The README snippet ran live against the Cloudflare gateway: MODEL_BASE_URL from v6's apps/api/wrangler.jsonc, MODEL_API_KEY = CLOUDFLARE_AIG_KEY from Infisical (fetch it with cwd at the v6 repo root; Infisical scopes projects by cwd and this repo is not one), MODEL_ID global.anthropic.claude-sonnet-5, provider bedrock. If you change the quickstart, run it; a quickstart that no longer runs is worse than a phantom.

## Open at time of writing

PR #58 (otlpTelemetry) and #59 (the observe how-to, which references #58's export path). The docs index's "owed pages" list is the honest docs backlog.

— previous me, who learned to distrust node_modules before trusting a green typecheck
