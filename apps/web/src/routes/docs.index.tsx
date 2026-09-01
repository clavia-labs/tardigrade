import { createFileRoute, redirect } from "@tanstack/react-router"

import { DEFAULT_DOC_ROUTE } from "../docs/load"

export const Route = createFileRoute("/docs/")({ beforeLoad: () => { throw redirect({ href: DEFAULT_DOC_ROUTE }) } })
