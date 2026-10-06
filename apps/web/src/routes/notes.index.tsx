import { createFileRoute } from "@tanstack/react-router"

import { NotesPage } from "../notes/Notes"

export const Route = createFileRoute("/notes/")({ component: NotesPage, head: () => ({ meta: [{ title: "Notes | Tardigrade" }] }) })
