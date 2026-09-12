import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { BedrockSend } from "../../../../packages/model/src/providers/bedrock"
import { modelLayerWith } from "../../../../packages/model/src/selection"
import { actor } from "tardie/core"
import { agentMethods, infer, outputValidateOnce, tool } from "tardie/agent"
import { createBunHost, serve } from "tardie/bun"
import { cleanup, registerCleanup } from "../../cleanup"
import { DEFAULT_LIVE_MAX_OUTPUT_TOKENS, DEFAULT_LIVE_TIMEOUT_MS, positive, type ResolvedLiveTarget } from "./config"
import { bindingFor } from "./layers"
import { observeTransport } from "./transport"
import { drivers } from "../targets"

type StoredEvent = { readonly type: string; readonly turn?: string; readonly callId?: string; readonly continuation?: unknown; readonly output?: string; readonly error?: { readonly reason?: { readonly _tag?: string; readonly description?: string } } }
type Stage = { readonly target: ResolvedLiveTarget; readonly mode: "initial" | "updated" | "handoff" | "recall"; readonly nonce: string }
type WireTool = { readonly name?: string; readonly parameters?: { readonly properties?: object; readonly required?: ReadonlyArray<string> }; readonly input_schema?: WireTool["parameters"]; readonly function?: WireTool; readonly toolSpec?: { readonly name: string; readonly inputSchema: { readonly json: WireTool["parameters"] } } }

const toolsOf = (mode: Stage["mode"]) => {
  const spec = (name: string, field?: string) => ({ name, description: "Return a fresh secret nonce after checking the previous answer", inputSchema: { type: "object", properties: field === undefined ? {} : { [field]: { type: "string" } }, ...(field === undefined ? {} : { required: [field] }), additionalProperties: false } })
  return mode === "initial" ? [spec("read_nonce")] : mode === "updated" ? [spec("read_nonce", "priorNonce"), spec("check_nonce", "nonce")] : mode === "handoff" ? [spec("check_nonce", "nonce")] : []
}

const assertTools = (body: string, stage: Stage) => {
  const request = JSON.parse(body) as { model?: string; modelId?: string; tools?: WireTool[]; toolConfig?: { tools?: WireTool[] } }
  assert.equal(request.model ?? request.modelId, stage.target.model, "Request must use the selected model")
  const tools = (request.tools ?? request.toolConfig?.tools ?? []).map((entry) => entry.toolSpec === undefined ? entry.function ?? entry : { name: entry.toolSpec.name, parameters: entry.toolSpec.inputSchema.json })
  const expected = toolsOf(stage.mode)
  assert.deepEqual(tools.map((entry) => entry.name).sort(), expected.map((entry) => entry.name).sort(), "Only current tools may be advertised")
  for (const spec of expected) {
    const tool = tools.find((entry) => entry.name === spec.name)!
    const schema = tool.parameters ?? ("input_schema" in tool ? tool.input_schema : undefined)
    assert.deepEqual(Object.keys(schema?.properties ?? {}).sort(), Object.keys(spec.inputSchema.properties).sort(), "Tool properties must use the current schema")
    assert.deepEqual([...(schema?.required ?? [])].sort(), [...(spec.inputSchema.required ?? [])].sort(), "Tool requirements must use the current schema")
  }
}

const runConversation = async (targets: ReadonlyArray<ResolvedLiveTarget>, lifecycle: boolean, overrides: { readonly bedrockSend?: BedrockSend } = {}) => {
  const first = targets[0]
  assert.ok(first, "Select at least one live target")
  assert.equal(new Set(targets.map((target) => target.id)).size, targets.length, "Live target IDs must be distinct")
  const timeout = positive("TARDIE_LIVE_TIMEOUT_MS", DEFAULT_LIVE_TIMEOUT_MS)
  const deadline = Date.now() + timeout
  const stages: Stage[] = [{ target: first, mode: "initial", nonce: crypto.randomUUID() }]
  if (lifecycle) {
    stages.push({ target: first, mode: "updated", nonce: crypto.randomUUID() })
    for (const target of targets.slice(1)) stages.push({ target, mode: "handoff", nonce: crypto.randomUUID() })
    stages.push({ target: first, mode: "recall", nonce: stages.at(-1)!.nonce })
  }
  const storage = await mkdtemp(join(tmpdir(), "inference-live-"))
  const cleanups: Array<() => unknown> = [() => rm(storage, { recursive: true, force: true })]
  let serverUrl: URL
  let stageIndex = 0
  let requests = 0
  let toolExecutions = 0
  let paused = false
  let followUpChecked = false
  let inspectionFailure: unknown
  const evidence: Array<Promise<{ target: ResolvedLiveTarget; opaque: ReadonlyArray<string> }>> = []
  const events = async (): Promise<ReadonlyArray<StoredEvent>> => {
    const response = await fetch(new URL("/v1/actors/main/threads/live/events", serverUrl))
    assert.equal(response.status, 200)
    return (await response.json() as Array<{ readonly event: StoredEvent }>).map((row) => row.event)
  }
  const inspect = async (target: ResolvedLiveTarget, body: string) => {
    try {
      requests++
      const stage = stages[stageIndex]!
      assert.equal(target.id, stage.target.id, "Request must reach the selected provider")
      assertTools(body, stage)
      const saved = JSON.stringify((await events()).filter((event) => event.type === "ModelReturned").map((event) => event.continuation))
      for (const entry of await Promise.all(evidence)) for (const opaque of entry.opaque) {
        assert.ok(saved.includes(JSON.stringify(opaque)), "Native reasoning must already be durable")
        const compatible = entry.target.id === target.id && entry.target.protocol === target.protocol && entry.target.model === target.model
        assert.equal(body.includes(JSON.stringify(opaque)), compatible, compatible ? "Compatible reasoning must survive replay" : "Foreign opaque reasoning must not cross the handoff")
      }
      for (const earlier of stages.slice(0, stageIndex)) assert.ok(body.includes(earlier.nonce), "Prior tool results must survive the handoff")
      if (toolExecutions > 0) {
        const followUp = drivers[target.protocol].followUpEvidence(body, stage.nonce)
        assert.ok(followUp.hasToolResult, "Follow-up request must include the current tool result")
        if (target.behaviors.includes("reasoning")) assert.ok(followUp.opaqueParts > 0, "Follow-up must include native reasoning evidence")
        followUpChecked = true
      }
    } catch (error) { inspectionFailure = error; throw error }
  }
  try {
    const connected = targets.map((target) => ({ target, ...observeTransport(target, (body) => inspect(target, body), (body) => {
      evidence.push(body.then((body) => ({ target, opaque: drivers[target.protocol].opaqueEvidence(body) })))
    }, cleanups, overrides.bedrockSend) }))
    const maxOutputTokens = positive("TARDIE_LIVE_MAX_OUTPUT_TOKENS", DEFAULT_LIVE_MAX_OUTPUT_TOKENS)
    const selection = { default: { provider: first.id, model_id: first.model }, allow: "*" as const }
    const config = {
      model: { ...selection, providers: Object.fromEntries(connected.map(({ target, endpoint }, index) => [target.id, { baseUrl: endpoint, protocol: target.protocol, env: [`LIVE_${index}`] }])) },
      modelCredentials: Object.fromEntries(targets.map((target, index) => [`LIVE_${index}`, target.apiKey]))
    }
    const catalog = { snapshot: { source: "models.dev" as const, revision: "live", refreshedAt: Date.now(), status: "fresh" as const, providers: targets.map((target) => ({ id: target.id, name: target.id, env: [], models: [{ id: target.model, metadata: { contextWindowTokens: target.contextWindowTokens, maxOutputTokens } }] })) } }
    const layers = () => modelLayerWith(config, catalog, (selected) => {
      const connection = connected.find(({ target }) => target.id === selected.provider)!
      return bindingFor({ ...connection.target, endpoint: connection.endpoint }, { providerId: selected.provider, ...(connection.bedrockSend === undefined ? {} : { bedrockSend: connection.bedrockSend }) })
    })
    const definition = () => actor({ name: "live-inference", methods: agentMethods, components: [infer([outputValidateOnce, tool(toolsOf(stages[stageIndex]!.mode).map((spec) => ({
      spec,
      run: (input) => Effect.gen(function* () {
        const turn = `m${stageIndex + 1}`
        assert.ok((yield* Effect.promise(events)).some((event) => event.type === "ModelReturned" && event.turn === turn && event.continuation !== undefined), "Continuation must be durable before the tool executes")
        if (lifecycle && stageIndex === 0 && !paused) { paused = true; return yield* Effect.never }
        assert.equal(spec.name, stages[stageIndex]!.mode === "handoff" ? "check_nonce" : "read_nonce", "The expected current tool must execute")
        const expected = stageIndex === 0 ? {} : { [stages[stageIndex]!.mode === "updated" ? "priorNonce" : "nonce"]: stages[stageIndex - 1]!.nonce }
        assert.deepEqual(input, expected, "Tool arguments must match the new schema and previous result")
        toolExecutions++
        assert.equal(toolExecutions, 1, "The tool effect must execute exactly once per turn")
        return { nonce: stages[stageIndex]!.nonce }
      })
    })))], { models: selection })] })
    const open = () => createBunHost({ actor: definition(), storage, layersFor: layers })
    let host = await open()
    let closeHost = registerCleanup(cleanups, host, (value) => value.close())
    let server = await serve(host, { port: 0 })
    let closeServer = registerCleanup(cleanups, server, (value) => value.close())
    serverUrl = server.url
    const reopen = async () => {
      await closeServer()
      await closeHost()
      host = await open()
      closeHost = registerCleanup(cleanups, host, (value) => value.close())
      server = await serve(host, { port: 0 })
      closeServer = registerCleanup(cleanups, server, (value) => value.close())
      serverUrl = server.url
    }
    const request = (path: string, method: string, body: unknown) => fetch(new URL(path, serverUrl), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const status = async (path: string) => (await (await fetch(new URL(path, serverUrl))).json() as { readonly status: string }).status
    const waitFor = async (predicate: () => Promise<boolean>) => {
      while (!await predicate()) {
        if (inspectionFailure !== undefined) throw inspectionFailure
        assert.ok(Date.now() < deadline, "Live conversation exceeded its configured deadline")
        await Bun.sleep(100)
      }
    }
    assert.equal((await request("/v1/actors/main", "PUT", {})).status, 200)
    assert.equal((await request("/v1/actors/main/threads", "POST", { name: "live" })).status, 200)
    for (const [index, stage] of stages.entries()) {
      stageIndex = index
      toolExecutions = 0
      followUpChecked = false
      const requestCount = requests
      const before = await events()
      const path = `/v1/actors/main/threads/live/methods/message/calls/m${index + 1}`
      const text = stage.mode === "recall" ? "Without calling tools, reply with the latest nonce from your previous answer exactly."
        : stage.mode === "initial" ? "Use read_nonce exactly once. Think about why you need the tool. Reply with its nonce exactly."
        : `Use ${stage.mode === "updated" ? "read_nonce with priorNonce" : "check_nonce with nonce"} set to the nonce from your previous answer, exactly once. Think about the changed tool contract. Reply with the new nonce returned by this tool exactly.`
      assert.equal((await request(path, "PUT", { text, model: { provider: stage.target.id, model_id: stage.target.model } })).status, 202)
      if (lifecycle && index === 0) {
        await waitFor(async () => paused || await status(path) !== "pending")
        assert.ok(paused, "The first turn must reach the durable reasoning checkpoint")
        const checkpoint = await events()
        assert.equal(checkpoint.filter((event) => event.type === "ModelReturned").length, 1)
        assert.equal(checkpoint.filter((event) => event.type === "ToolReturned").length, 0)
        assert.equal(requests, 1, "Restart must happen before the follow-up request")
        await reopen()
        assert.ok(JSON.stringify((await events()).slice(0, checkpoint.length)) === JSON.stringify(checkpoint), "Recovery must preserve the checkpoint events")
      }
      await waitFor(async () => await status(path) !== "pending")
      if (inspectionFailure !== undefined) throw inspectionFailure
      const failure = (await events()).findLast((event) => event.type === "ModelReturned" && event.turn === `m${index + 1}` && event.error !== undefined)?.error?.reason
      const detail = targets.reduce((text, target) => text.replaceAll(target.apiKey, "[redacted]"), failure?.description ?? failure?._tag ?? "no provider error")
      assert.equal(await status(path), "completed", `Live turn ${index + 1} (${stage.target.id}) must complete: ${detail}`)
      assert.equal(requests - requestCount, stage.mode === "recall" ? 1 : 2, "Each turn must use only its planned requests, including after recovery")
      assert.equal(toolExecutions, stage.mode === "recall" ? 0 : 1)
      if (stage.mode !== "recall") assert.ok(followUpChecked, "The provider must receive the tool result")
      const saved = await events()
      assert.ok(JSON.stringify(saved.slice(0, before.length)) === JSON.stringify(before), "Previous durable events must remain unchanged")
      assert.ok(saved.some((event) => event.type === "TurnCompleted" && event.turn === `m${index + 1}` && event.output?.includes(stage.nonce)), "Completion must preserve the nonce through the conversation")
      if (stage.target.behaviors.includes("reasoning") && stage.mode !== "recall") assert.ok((await Promise.all(evidence)).some((entry) => entry.target.id === stage.target.id && entry.opaque.length > 0), "Reasoning must have native replay evidence")
      const count = requests
      stageIndex = Math.min(index + 1, stages.length - 1)
      await reopen()
      assert.ok(JSON.stringify(await events()) === JSON.stringify(saved), "Events must survive completed-turn restart")
      assert.equal(await status(path), "completed")
      assert.equal(requests, count, "Completed-turn recovery must not infer again")
    }
    return { turns: stages.length, requests }
  } finally { await cleanup(cleanups) }
}

export const runTarget = (target: ResolvedLiveTarget, overrides: { readonly bedrockSend?: BedrockSend } = {}) => runConversation([target], false, overrides)
export const runLifecycle = (targets: ReadonlyArray<ResolvedLiveTarget>, overrides: { readonly bedrockSend?: BedrockSend } = {}) => runConversation(targets, true, overrides)
