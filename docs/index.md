# yog-client-tui docs

Taxonomy: one directory per concern, `index.md` in each. Start here.

| Doc                                             | Concern                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| [architecture](architecture/index.md)           | The domain layout: what each directory owns and the dependency rules between them. |
| [server-connection](server-connection/index.md) | Configuration, startup sequence, session lifecycle, and recovery.                  |
| [ui](ui/index.md)                               | The render pipeline, components, focus model, tables, and theming.                 |
| [interaction](interaction/index.md)             | Key bindings, the input bar, slash commands, and debug mode.                       |

Source layout lives in the [README file map](../README.md); the
dependency graph image lives on the `assets` branch. For the wire contract
the TUI speaks, see the server repo's
[contract reference](https://github.com/haliphax-ai/yog/blob/main/docs/contract.md).
