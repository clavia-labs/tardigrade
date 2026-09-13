import { FetchHttpHandler } from "@smithy/fetch-http-handler"
import type { StreamBounds } from "../stream/policy"

type SmithyHandler = Pick<FetchHttpHandler, "handle" | "destroy">

export const bedrockGatewayHandler = (apiKey: string, bounds: StreamBounds): SmithyHandler => {
  const transport: Promise<SmithyHandler> =
    (globalThis as { Bun?: unknown }).Bun === undefined
      ? Promise.resolve(new FetchHttpHandler({ requestTimeout: bounds.attemptMs ?? 0 }))
      : (() => {
          const moduleName = "@smithy/node-http-handler"
          return (import(/* @vite-ignore */ moduleName) as Promise<typeof import("@smithy/node-http-handler")>).then(
            ({ NodeHttpHandler: Handler }) =>
              new Handler({
                connectionTimeout: bounds.firstChunkMs,
                socketTimeout: bounds.idleMs,
                requestTimeout: bounds.attemptMs ?? 0,
                throwOnRequestTimeout: true
              })
          )
        })()

  return {
    handle: async (request, handlerOptions) => {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(([key]) => key.toLowerCase() !== "authorization")
      )
      request.headers["cf-aig-authorization"] = `Bearer ${apiKey}`
      return (await transport).handle(request, handlerOptions)
    },
    destroy: () => {
      void transport.then((handler) => handler.destroy()).catch(() => undefined)
    }
  }
}
