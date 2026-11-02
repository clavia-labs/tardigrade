import { createFileRoute } from "@tanstack/react-router"

import { ConsolePage } from "../site/ConsolePage"

export const Route = createFileRoute("/console")({ component: ConsolePage, ssr: false })
