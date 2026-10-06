import type { ComponentPropsWithoutRef, ReactElement } from "react"

export const NotesLink = ({ href, target, rel, ...props }: ComponentPropsWithoutRef<"a">): ReactElement => {
  const external = /^(?:https?:)?\/\//.test(href ?? "")
  return <a {...props} href={href} target={external ? "_blank" : target} rel={external ? "noopener noreferrer" : rel} />
}
