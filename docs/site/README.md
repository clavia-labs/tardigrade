# Web documentation

The web application renders the published `.mdx` files registered in `apps/web/src/docs/load.ts`. Each page owns its route and navigation position through frontmatter. Draft files stay outside the registry.

## Frontmatter

Every page provides these fields:

```yaml
---
title: Getting Started
description: Build and run your first durable agent.
route: /guide
section: Introduction
sectionOrder: 1
order: 1
articleClass: optional-css-class
---
```

`route` starts with `/` and omits a trailing slash. `sectionOrder` orders sidebar sections. `order` orders pages within a section. `articleClass` is optional. Missing fields, invalid routes, and duplicate routes stop the web build.

## Components

Pages can use standard Markdown and these components without imports:

- `Command` renders a copyable shell command from `value` and an optional `label`.
- `Filesystem` renders a Markdown list as a file tree.
- `AnnotatedExample` and `AnnotatedCode` render a code example with explanations.
- `Code` renders every fenced code block with its language, syntax highlighting, and a copy control. Fences use the multi-line panel by default. Add `variant="single"` after the language to render the compact command form.
- Add `expanded` after the language when a multi-line block should show its complete height.
- `ConceptSection` and `ConceptInterface` arrange the concepts page.
- `ActorDiagram`, `TransitionLoop`, `ComponentDiagram`, `MethodDiagram`, and `RlmDiagram` render interactive or illustrated material.

Reusable components live in `apps/web/src/docs/components/index.tsx`. Add a component to its `mdxComponents` map before using its name in MDX.
