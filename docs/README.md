# yog-client-tui docs

Taxonomy: one directory per concern, `README.md` in each. Start here.

| Doc                                              | Concern                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [architecture](architecture/README.md)           | The domain layout: what each directory owns and the dependency rules between them. |
| [server-connection](server-connection/README.md) | Configuration, startup sequence, session lifecycle, and recovery.                  |
| [ui](ui/README.md)                               | The render pipeline, components, focus model, tables, and theming.                 |
| [interaction](interaction/README.md)             | Key bindings, the input bar, slash commands, and debug mode.                       |

Source layout lives in the [README file map](../README.md); the
dependency graph image lives on the `assets` branch. For the wire contract
the TUI speaks, see the server repo's
[contract reference](https://github.com/haliphax-ai/yog/blob/main/docs/contract.md).
