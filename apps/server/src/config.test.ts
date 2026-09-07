import { describe, expect, test } from "bun:test"
import {
  DEFAULT_ACTORS,
  DEFAULT_ACTOR_DATA,
  DEFAULT_DB,
  DEFAULT_MAX_CONCURRENT_THREADS,
  DEFAULT_PORT,
  projectConfigOf,
  readConfig
} from "./config"

describe("config", () => {
  test("defaults are the exported constants", () => {
    const config = readConfig({})
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.db).toBe(DEFAULT_DB)
    expect(config.actors).toBe(DEFAULT_ACTORS)
    expect(config.actorData).toBe(DEFAULT_ACTOR_DATA)
    expect(config.maxConcurrentThreads).toBe(DEFAULT_MAX_CONCURRENT_THREADS)
    expect(config.token).toBeUndefined()
    expect(config.model).toEqual({
      allow: "*",
      providers: {}
    })
    expect(config.modelCredentials).toEqual({})
    expect(config.catalog).toEqual({
      sourceUrl: "https://models.dev/api.json",
      cachePath: ".tardigrade/models.json",
      timeoutMillis: 10_000
    })
  })

  test("the environment overrides every default", () => {
    const config = readConfig({
      PORT: "8080",
      TARDIGRADE_DB: "/var/lib/agents.sqlite",
      TARDIGRADE_ACTORS: "/var/lib/actors",
      TARDIGRADE_ACTOR_DATA: "/var/lib/actor-data",
      TARDIGRADE_MAX_CONCURRENT_THREADS: "7",
      TARDIGRADE_TOKEN: "secret"
    })
    expect(config.port).toBe(8080)
    expect(config.db).toBe("/var/lib/agents.sqlite")
    expect(config.actors).toBe("/var/lib/actors")
    expect(config.actorData).toBe("/var/lib/actor-data")
    expect(config.maxConcurrentThreads).toBe(7)
    expect(config.token).toBe("secret")
    expect(config.model).toEqual({ allow: "*", providers: {} })
    expect(config.modelCredentials).toEqual({})
    expect(config.catalog).toEqual({
      sourceUrl: "https://models.dev/api.json",
      cachePath: ".tardigrade/models.json",
      timeoutMillis: 10_000
    })
  })

  test("the catalog source, cache, and timeout are configurable", () => {
    const config = readConfig({
      TARDIGRADE_MODEL_CATALOG_URL: "https://catalog.example/models.json",
      TARDIGRADE_MODEL_CATALOG_CACHE: "/var/cache/tardigrade/models.json",
      TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS: "2500"
    })
    expect(config.catalog).toEqual({
      sourceUrl: "https://catalog.example/models.json",
      cachePath: "/var/cache/tardigrade/models.json",
      timeoutMillis: 2500
    })
    expect(() => readConfig({ TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS: "0" })).toThrow("positive integer")
  })

  test("provider configuration and credentials resolve from separate sources", () => {
    const project = projectConfigOf({
      vars: { TARDIGRADE_CONFIG: { models: {
        default: { provider: "openai", model_id: "gpt" },
        allow: [{ provider: "openai", model_ids: ["gpt"] }],
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            protocol: "openai-responses",
            env: ["OPENAI_API_KEY"]
          }
        }
      } } }
    })
    const config = readConfig({ OPENAI_API_KEY: "secret" }, project)
    expect(config.model).toMatchObject({
      default: { provider: "openai", model_id: "gpt" },
      allow: [{ provider: "openai", model_ids: ["gpt"] }],
      providers: { openai: { protocol: "openai-responses" } }
    })
    expect(config.modelCredentials).toEqual({ OPENAI_API_KEY: "secret" })
    expect(() => projectConfigOf({
      vars: { TARDIGRADE_CONFIG: { models: { allow: "*", providers: { openai: { apiKey: "must-not-live-here", env: ["OPENAI_API_KEY"] } } } } }
    })).toThrow("cannot contain apiKey")
    expect(() => projectConfigOf({
      vars: { TARDIGRADE_CONFIG: { models: { allow: "*", providers: { openai: { baseUrl: "https://api.openai.com/v1", protocol: "openai-responses", env: ["bad-name"] } } } } }
    })).toThrow("invalid name")
    expect(() => projectConfigOf({
      vars: { TARDIGRADE_CONFIG: { models: { default: { provider: "missing", model_id: "gpt" }, allow: "*", providers: {} } } }
    })).toThrow("unconfigured provider")
    expect(() => projectConfigOf({ models: {} })).toThrow("vars.TARDIGRADE_CONFIG")
  })

  test("legacy model variables print a redacted replacement", () => {
    const env = {
      MODEL_PROVIDER: "openai",
      MODEL_ID: "gpt-5.2",
      MODEL_BASE_URL: "https://api.openai.com/v1",
      MODEL_API_KEY: "secret-that-must-not-print"
    }
    let message = ""
    try {
      readConfig(env)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain("wrangler.jsonc")
    expect(message).toContain('"default":{"provider":"openai","model_id":"gpt-5.2"}')
    expect(message).toContain('"protocol":"<protocol>"')
    expect(message).toContain('"env":["<api-key-env>"]')
    expect(message).not.toContain(env.MODEL_API_KEY)
  })

  // Listening somewhere other than where the operator asked is worse than refusing to start.
  test("a PORT that is not a port refuses to resolve", () => {
    expect(() => readConfig({ PORT: "http" })).toThrow()
    expect(() => readConfig({ PORT: "70000" })).toThrow()
  })

  test("a concurrency cap that cannot schedule a thread refuses to resolve", () => {
    expect(() => readConfig({ TARDIGRADE_MAX_CONCURRENT_THREADS: "0" })).toThrow("positive integer")
    expect(() => readConfig({ TARDIGRADE_MAX_CONCURRENT_THREADS: "many" })).toThrow("positive integer")
  })
})

