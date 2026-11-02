import { codeToTokens, isSupportedLanguage } from "@pierre/highlights"
import dark from "@pierre/highlights/themes/pierre-dark"
import light from "@pierre/highlights/themes/pierre-light"

type Node = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  value?: string
  children?: Node[]
}

export const highlight = () => (tree: Node): void => {
  const visit = (node: Node): void => {
    if (node.tagName === "pre") {
      const code = node.children?.find(child => child.tagName === "code")
      const classes = code?.properties?.className
      const language = Array.isArray(classes) ? classes.find((value: unknown): value is string => typeof value === "string" && value.startsWith("language-"))?.slice(9) : undefined
      if (code !== undefined && language !== undefined && isSupportedLanguage(language)) {
        const source = code.children?.map(child => child.value ?? "").join("") ?? ""
        const result = codeToTokens(source, { lang: language, themes: { light, dark }, defaultColor: "light-dark()" })
        code.children = result.tokens.flatMap((line, index): Node[] => [
          ...(index === 0 ? [] : [{ type: "text", value: "\n" }]),
          ...line.map(token => ({ type: "element", tagName: "span", properties: { style: Object.entries(token.htmlStyle ?? {}).map(([key, value]) => `${key}:${value}`).join(";") }, children: [{ type: "text", value: token.content }] }))
        ])
      }
      return
    }
    node.children?.forEach(visit)
  }
  visit(tree)
}
