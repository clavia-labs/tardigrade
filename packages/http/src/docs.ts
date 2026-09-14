import { Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiGroup, HttpApiScalar, OpenApi } from "effect/unstable/httpapi"
import { DOCS_PATH, OPENAPI_PATH } from "@clavia/tardigrade-client/contract"

// UNAUTHENTICATED_PATHS names public discovery routes (apps/server/src/contract.test.ts, platform/cloudflare/test/actor.workers.ts).
export const UNAUTHENTICATED_PATHS: ReadonlyArray<string> = ["/healthz", "/v1/providers", "/v1/models", OPENAPI_PATH, DOCS_PATH]

const scalarCss = `
@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap");

:root {
  --scalar-font: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --scalar-font-code: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --scalar-background-1: #f3f0e4;
  --scalar-background-2: #faf8ef;
  --scalar-background-3: #e9eadc;
  --scalar-background-accent: #e2eadf;
  --scalar-color-1: #243128;
  --scalar-color-2: #556158;
  --scalar-color-3: #879087;
  --scalar-color-accent: #4f6f52;
  --scalar-border-color: #d1d6c2;
  --scalar-radius: 6px;
  --scalar-radius-lg: 6px;
}

.dark-mode {
  --scalar-background-1: #131514;
  --scalar-background-2: #1b1d1c;
  --scalar-background-3: #0e100f;
  --scalar-background-accent: #22302a;
  --scalar-color-1: #e8eae8;
  --scalar-color-2: #a3a8a4;
  --scalar-color-3: #6b706c;
  --scalar-color-accent: #7fae8c;
  --scalar-border-color: #2a2d2b;
}
`.trim()

// layerApiDocs serves an API's OpenAPI document and Scalar reference (apps/server/src/contract.test.ts, platform/cloudflare/test/actor.workers.ts).
export const layerApiDocs = <Id extends string, Groups extends HttpApiGroup.Constraint>(api: HttpApi.HttpApi<Id, Groups>) =>
  Layer.mergeAll(
    HttpRouter.add("GET", OPENAPI_PATH, HttpServerResponse.jsonUnsafe(OpenApi.fromApi(api))),
    HttpApiScalar.layer(api, {
      path: DOCS_PATH,
      scalar: { customCss: scalarCss, theme: "none", withDefaultFonts: false }
    })
  )
