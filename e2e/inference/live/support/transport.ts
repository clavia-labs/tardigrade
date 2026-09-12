import assert from "node:assert/strict"
import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime"
import type { BedrockSend } from "../../../../packages/model/src/providers/bedrock"
import { registerCleanup } from "../../cleanup"
import type { ResolvedLiveTarget } from "./config"

export const observeTransport = (target: ResolvedLiveTarget, inspect: (body: string) => Promise<void>, record: (body: Promise<string>) => void, cleanups: Array<() => unknown>, injectedSend?: BedrockSend): { readonly endpoint: string; readonly bedrockSend?: BedrockSend } => {
  if (target.protocol !== "bedrock-converse") {
    const proxy = Bun.serve({ port: 0, fetch: async (request) => {
      const body = await request.text()
      await inspect(body)
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.delete("content-length")
      const response = await fetch(`${target.endpoint.replace(/\/$/, "")}${new URL(request.url).pathname}`, { method: "POST", headers, body, signal: request.signal })
      record((async () => {
        const reader = response.clone().body?.getReader()
        const decoder = new TextDecoder()
        let text = ""
        try {
          if (reader !== undefined) while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            text += decoder.decode(chunk.value, { stream: true })
          }
        } catch {
          // reader retains evidence received before the provider closes its stream.
        } finally { reader?.releaseLock() }
        return text + decoder.decode()
      })())
      return response
    } })
    registerCleanup(cleanups, proxy, (value) => value.stop(true))
    return { endpoint: proxy.url.toString().replace(/\/$/, "") }
  }
  let send = injectedSend
  if (send === undefined) {
    assert.ok(target.region, "Bedrock requires an AWS region")
    const client = new BedrockRuntimeClient({ region: target.region, endpoint: target.endpoint, token: { token: target.apiKey }, authSchemePreference: ["httpBearerAuth"], maxAttempts: 1 })
    registerCleanup(cleanups, client, (value) => value.destroy())
    send = (input, signal) => client.send(new ConverseStreamCommand(input), { abortSignal: signal })
  }
  const nativeSend = send
  return { endpoint: target.endpoint, bedrockSend: async (input, signal) => {
    await inspect(JSON.stringify(input))
    const response = await nativeSend(input, signal)
    const stream = response.stream
    if (stream === undefined) return response
    const observed: ConverseStreamOutput[] = []
    return { ...response, stream: (async function* () {
      try { for await (const event of stream) { observed.push(event); yield event } }
      finally { record(Promise.resolve(JSON.stringify(observed))) }
    })() }
  } }
}
