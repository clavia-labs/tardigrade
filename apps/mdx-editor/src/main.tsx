import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { tags } from "@lezer/highlight"
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CodeMirrorEditor,
  CreateLink,
  DiffSourceToggleWrapper,
  GenericJsxEditor,
  InsertCodeBlock,
  ListsToggle,
  MDXEditor,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  frontmatterPlugin,
  headingsPlugin,
  jsxPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  type JsxComponentDescriptor,
  type RealmPlugin
} from "@mdxeditor/editor"
import { Plugin, TextFileView, WorkspaceLeaf } from "obsidian"
import { useEffect, useMemo, useState, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"

const VIEW_TYPE_MDX_EDITOR = "mdx-editor"

const blockComponent = (
  name: string,
  props: JsxComponentDescriptor["props"] = [],
  hasChildren = true
): JsxComponentDescriptor => ({
  Editor: GenericJsxEditor,
  hasChildren,
  kind: "flow",
  name,
  props,
  source: ""
})

const jsxComponentDescriptors: ReadonlyArray<JsxComponentDescriptor> = [
  blockComponent("Filesystem", [{ name: "root", type: "string" }]),
  blockComponent("Tip", [{ name: "title", type: "string" }]),
  blockComponent("EventLog"),
  blockComponent("Command", [
    { name: "label", type: "string" },
    { name: "value", type: "string" }
  ], false),
  blockComponent("ProjectTree", [
    { name: "name", type: "string" },
    { name: "runtime", type: "expression" }
  ]),
  blockComponent("ProjectFile", [{ name: "name", type: "string" }]),
  blockComponent("AnnotatedExample"),
  blockComponent("AnnotatedCode", [
    { name: "description", type: "string" },
    { name: "title", type: "string" },
    { name: "tone", type: "string" }
  ]),
  blockComponent("ConceptInterface"),
  blockComponent("ConceptSection", [{ name: "kind", type: "string" }]),
  blockComponent("ActorDiagram", [], false),
  blockComponent("ComponentDiagram", [], false),
  blockComponent("CompactionMachineDiagram", [], false),
  blockComponent("HarnessDiagram", [], false),
  blockComponent("Math", [{ name: "expression", type: "string" }], false),
  blockComponent("MethodDiagram", [], false),
  blockComponent("PrimitiveDiagram", [], false),
  blockComponent("TransitionLoop", [], false),
  blockComponent("RlmDiagram", [], false)
]

const obsidianCodeTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background-primary)",
    color: "var(--text-normal)"
  },
  ".cm-activeLine": {
    backgroundColor: "var(--background-modifier-hover)"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--background-modifier-hover)"
  },
  ".cm-content": {
    caretColor: "var(--text-normal)"
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--text-normal)"
  },
  ".cm-gutters": {
    backgroundColor: "var(--background-secondary)",
    borderRightColor: "var(--background-modifier-border)",
    color: "var(--text-faint)"
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--text-selection)"
  }
})

const obsidianCodeHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "var(--color-purple)" },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: "var(--text-normal)" },
  { tag: [tags.propertyName], color: "var(--color-cyan)" },
  { tag: [tags.variableName], color: "var(--text-normal)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "var(--color-blue)" },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: "var(--color-orange)" },
  { tag: [tags.definition(tags.name), tags.separator], color: "var(--color-cyan)" },
  { tag: [tags.typeName, tags.className, tags.number, tags.bool, tags.null], color: "var(--color-orange)" },
  { tag: [tags.changed, tags.annotation, tags.self, tags.namespace], color: "var(--color-yellow)" },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link], color: "var(--color-red)" },
  { tag: [tags.meta, tags.comment], color: "var(--text-muted)", fontStyle: "italic" },
  { tag: [tags.strong], fontWeight: "bold" },
  { tag: [tags.emphasis], fontStyle: "italic" },
  { tag: [tags.strikethrough], textDecoration: "line-through" },
  { tag: [tags.string, tags.special(tags.string), tags.inserted], color: "var(--color-green)" },
  { tag: [tags.invalid], color: "var(--text-error)" }
])

const editorPlugins = (): ReadonlyArray<RealmPlugin> => [
  toolbarPlugin({
    toolbarContents: () => (
      <DiffSourceToggleWrapper>
        <UndoRedo />
        <BlockTypeSelect />
        <BoldItalicUnderlineToggles />
        <ListsToggle />
        <CreateLink />
        <InsertCodeBlock />
      </DiffSourceToggleWrapper>
    )
  }),
  headingsPlugin(),
  listsPlugin(),
  quotePlugin(),
  thematicBreakPlugin(),
  linkPlugin(),
  linkDialogPlugin(),
  tablePlugin(),
  frontmatterPlugin(),
  codeBlockPlugin({
    codeBlockEditorDescriptors: [{
      Editor: CodeMirrorEditor,
      match: () => true,
      priority: -10
    }],
    defaultCodeBlockLanguage: "text"
  }),
  codeMirrorPlugin({
    codeBlockLanguages: {
      bash: "Bash",
      css: "CSS",
      json: "JSON",
      jsonc: "JSON with comments",
      text: "Plain text",
      ts: "TypeScript",
      tsx: "TypeScript React",
      yaml: "YAML"
    },
    codeMirrorExtensions: [
      obsidianCodeTheme,
      syntaxHighlighting(obsidianCodeHighlight)
    ]
  }),
  jsxPlugin({ jsxComponentDescriptors: [...jsxComponentDescriptors] }),
  diffSourcePlugin({ viewMode: "rich-text" }),
  markdownShortcutPlugin()
]

const useDarkTheme = (): boolean => {
  const [dark, setDark] = useState(() => document.body.classList.contains("theme-dark"))
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.body.classList.contains("theme-dark")))
    observer.observe(document.body, { attributeFilter: ["class"], attributes: true })
    return () => observer.disconnect()
  }, [])
  return dark
}

const MdxDocumentEditor = ({ markdown, onChange }: {
  readonly markdown: string
  readonly onChange: (markdown: string, initialMarkdownNormalize: boolean) => void
}): ReactElement => {
  const dark = useDarkTheme()
  const plugins = useMemo(editorPlugins, [])
  return (
    <MDXEditor
      className={dark ? "dark-theme mdx-editor" : "mdx-editor"}
      contentEditableClassName="mdx-editor-content"
      markdown={markdown}
      onChange={onChange}
      plugins={[...plugins]}
      toMarkdownOptions={{ bullet: "-", listItemIndent: "one" }}
    />
  )
}

class MdxEditorView extends TextFileView {
  private markdown = ""
  private revision = 0
  private root: Root | undefined

  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
    this.navigation = true
  }

  getViewType(): string {
    return VIEW_TYPE_MDX_EDITOR
  }

  getDisplayText(): string {
    return this.file?.basename ?? "MDX editor"
  }

  getIcon(): string {
    return "file-code-2"
  }

  getViewData(): string {
    return this.markdown
  }

  setViewData(data: string, _clear: boolean): void {
    if (data === this.markdown && this.root !== undefined) return
    this.markdown = data
    this.revision += 1
    this.renderEditor()
  }

  clear(): void {
    this.markdown = ""
    this.root?.unmount()
    this.root = undefined
    this.contentEl.empty()
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mdx-editor-view")
    this.root = createRoot(this.contentEl)
    this.renderEditor()
  }

  async onClose(): Promise<void> {
    this.root?.unmount()
    this.root = undefined
  }

  private readonly change = (markdown: string, initialMarkdownNormalize: boolean): void => {
    if (markdown === this.markdown) return
    const sourceMode = this.contentEl.querySelector(".mdxeditor-source-editor") !== null
    if (initialMarkdownNormalize && !sourceMode) return
    this.markdown = markdown
    this.requestSave()
  }

  private renderEditor(): void {
    this.root?.render(
      <MdxDocumentEditor key={this.revision} markdown={this.markdown} onChange={this.change} />
    )
  }
}

export default class MdxEditorPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_MDX_EDITOR, (leaf) => new MdxEditorView(leaf))
    this.registerExtensions(["mdx"], VIEW_TYPE_MDX_EDITOR)
  }
}
