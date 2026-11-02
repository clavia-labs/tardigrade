import { Link } from "@tanstack/react-router"
import { type ReactElement } from "react"
import { docPages } from "../load"

// NotesList links published notes and excludes the section index.
export const NotesList = (): ReactElement => (
  <ul className="notes-list">
    {docPages.filter(doc => doc.frontmatter.section === "Notes" && doc.frontmatter.route !== "/notes").map(doc => (
      <li key={doc.frontmatter.route}>
        <Link to={doc.frontmatter.route}>{doc.frontmatter.title}</Link>
        <p>{doc.frontmatter.description}</p>
      </li>
    ))}
  </ul>
)
