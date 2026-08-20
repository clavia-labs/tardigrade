import { DOCS_PATH } from "@clavia/tardigrade-client/contract"
import type { ReactElement } from "react"

import { client } from "./client"

export const ApiSurface = (): ReactElement => (
  <iframe className="api-surface" src={`${client.baseUrl}${DOCS_PATH}`} title="Tardigrade API reference" />
)
