import { DOCS_PATH } from "@clavia/tardigrade-client/contract"
import { ArrowLeft } from "@phosphor-icons/react"
import type { ReactElement } from "react"

import { client } from "./client"
import { navigate } from "./nav"
import { ICON_SIZE } from "./policy"

export const ApiSurface = (): ReactElement => (
  <main className="api-view">
    <iframe className="api-surface" src={`${client.baseUrl}${DOCS_PATH}`} title="Tardigrade API reference" />
    <button
      type="button"
      className="api-back"
      onClick={() => navigate({ view: undefined }, { replace: true })}
    >
      <ArrowLeft size={ICON_SIZE} weight="light" aria-hidden="true" />
      Voyager
    </button>
  </main>
)
