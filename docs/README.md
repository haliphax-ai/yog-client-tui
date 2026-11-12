# yog-client-tui docs

Taxonomy: one document per concern. Start here.

| Doc                                       | Concern                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| [architecture](architecture.md)           | The domain layout: what each directory owns and the dependency rules between them. |
| [server-connection](server-connection.md) | Configuration, startup sequence, session lifecycle, and recovery.                  |
| [ui](ui.md)                               | The render pipeline, components, focus model, tables, and theming.                 |
| [interaction](interaction.md)             | Key bindings, the input bar, slash commands, and debug mode.                       |

Source layout lives in the [README file map](../README.md); the
dependency graph image lives on the `assets` branch. For the wire contract
the TUI speaks, see the server repo's
[contract reference](https://github.com/haliphax-ai/yog/blob/main/docs/contract.md).
