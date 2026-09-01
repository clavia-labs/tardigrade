import { createFileRoute } from "@tanstack/react-router"

import { ConsolePage } from "../App"

export const Route = createFileRoute("/console")({ component: ConsolePage, ssr: false })
