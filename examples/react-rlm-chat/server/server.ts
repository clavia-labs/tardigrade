import { join } from "node:path"
import { createBunHost, serve } from "tardie/bun"
import { bunModelServices } from "tardie/server/model-services"
import definition from "./actor"

const { config, layers, api } = await bunModelServices({
  configFile: new URL("wrangler.jsonc", import.meta.url),
  env: process.env,
  configure: () => ({ maxOutputTokens: 4096 })
})

const storage = config.db === ":memory:" ? ":memory:" : `${config.db}.actors`
const host = await createBunHost({
  actor: definition,
  storage,
  storageLayout: {
    databaseFor: (instance) => storage === ":memory:"
      ? ":memory:"
      : join(storage, `${Buffer.from(instance, "utf8").toString("base64url")}.sqlite`),
    instanceFromFile: (file) => file.endsWith(".sqlite")
      ? Buffer.from(file.slice(0, -7), "base64url").toString("utf8")
      : undefined
  },
  driver: { maxConcurrentThreads: config.maxConcurrentThreads },
  layersFor: () => layers
})

try {
  const server = await serve(host, {
    port: config.port,
    token: config.token,
    api
  })
  try {
    console.log(`Recursive Chat listening at ${server.url}`)
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop)
        process.off("SIGTERM", stop)
        resolve()
      }
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    })
  } finally {
    await server.close()
  }
} finally {
  await host.close()
}
