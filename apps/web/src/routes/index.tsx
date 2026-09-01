import { createFileRoute } from "@tanstack/react-router"

import { LandingPage } from "../App"

export const Route = createFileRoute("/")({ component: LandingPage })
