# React chat

This example shows a React chat UI driven by a Tardigrade event log. It uses Base UI, Phosphor Icons, and TanStack Query.

Add `OPENROUTER_API_KEY` to `.dev.vars`, then build and start the example from the repository root:

```sh
bun run --cwd examples/react-chat agent
```

Open `http://localhost:4242`. The server serves the built UI, durable thread events, and transient inference text from the same origin.
