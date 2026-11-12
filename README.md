# yog-client-tui

A terminal chat client for yog-style HTTP/SSE servers, built with Node.js and
TypeScript. It opens a session, streams assistant replies into a scrollable
log viewport, and resumes where it left off: the server owns the canonical
transcript, so turns send only the new prompt and a relaunch rehydrates the
whole conversation from the server before the first prompt.

## Documentation

The docs live in `docs/`, split by concern with an index per directory:

- [Architecture](docs/architecture/README.md): domain layout and the
  dependency rules between domains.
- [Server connection](docs/server-connection/README.md): configuration,
  startup, turns, and recovery.
- [UI](docs/ui/README.md): the render pipeline, components, tables, and
  theming.
- [Interaction](docs/interaction/README.md): key bindings, the input bar,
  slash commands, and debug mode.

## File map

```
src/
  main.ts           Composition root: wiring only (terminal lifecycle, key
                    routing, render scheduling). The only module allowed to
                    import config/.
  config.ts         Config parsing/validation; config/state file locations.
  yogClient.ts      The yog HTTP/SSE transport: capabilities, sessions,
                    turns, transcript rehydration, recovery. Terminal-free.
  core/             The domain model: log entries, the state store, the focus
                    ring, scroll math, transcript conversion, the turn
                    presenter, slash commands.
  ui/               Presentation: components, the staged render pipeline, the
                    table engine, the theme.
    components/     Chat log/viewport, input bar, status line, drawer,
                    focus-scoped key router, raw input decoding.
    pipeline/       Stage runner (layout, paint, compose, post, emit), hook
                    registry, frame scheduler, frame writer.
    render/         Entry rendering, markdown/prose, the table engine
                    (parse, layout, render, scroll), the memoized row cache.
  util/             ANSI cell math and fuzzy matching. A leaf domain.
test/               Vitest suites mirroring the source tree.
config.example.json The committed config template (a real config.json is
                    git-ignored).
patches/            patch-package overlay for @oakoliver/bubbles width
                    tables (see AGENTS.md).
helpers/            align-columns.mjs, a script used to align markdown tables.
```

The domains are separated by enforced dependency rules (`npm run depcruise`).
`client/` never touches the terminal and `ui/` never touches the transport,
so either side can change without the other. The full rules and the module
inventory are in [docs/architecture](docs/architecture/README.md).

## Dependency graph

<details><summary>Dependency graph</summary>
<br />

![Dependency graph](https://raw.githubusercontent.com/haliphax-ai/yog-client-tui/refs/heads/assets/dependencies.jpg)
</details>

Regenerate the Mermaid source with `npm run depcruise:graph`; the image is
maintained on the `assets` branch.
