# deeplocal-chat-adapter

`deeplocal-chat-adapter` is a VS Code extension that connects local DeepLocal
models and remote OpenAI-compatible APIs to VS Code chat. It provides a
sidebar for conversational coding tasks and registers discovered models in the
VS Code chat model picker.

![DeepLocal extension screenshot](https://github.com/user-attachments/assets/0aaa5510-024a-418b-a7d5-82ee34789461)

## Quick Start & Testing (Debug Mode)

To quickly test the extension during development:

1. Open the project in VS Code.
2. Press `F5`, or open **Run and Debug** and select **Start Debugging**.
3. A new Extension Development Host window opens.
4. In that window, open the VS Code Chat view or the built-in sidebar chat to
   test the deeplocal-chat-adapter integration.

## Install from VS Code Marketplace (recommended)

Install the extension directly from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=petertzy.deeplocal-chat-adapter), or open the **Extensions** view in VS Code and search for `@id:petertzy.deeplocal-chat-adapter`. Select **Install**.

## Install from GitHub Releases

Download the latest `.vsix` package from the [GitHub Releases page](https://github.com/petertzy/deeplocal-chat-adapter/releases). You do not need Node.js or npm to install a prebuilt VSIX.

1. Download the `deeplocal-chat-adapter-<version>.vsix` file from the release's **Assets** section.
2. Open VS Code (version 1.104 or later) and go to the **Extensions** view (`Ctrl+Shift+X` on Windows/Linux or `Cmd+Shift+X` on macOS).
3. Select the **...** menu in the Extensions view and choose **Install from VSIX...**.
4. Select the downloaded file and reload VS Code if prompted.
5. Open the Command Palette and run `deeplocal-chat-adapter: Open`.
6. Configure a running local DeepLocal service or a compatible remote API as described in [Configure a backend](#configure-a-backend).

Alternatively, install the downloaded package from a terminal:

```bash
code --install-extension ./deeplocal-chat-adapter-0.1.0.vsix
```

Replace the example filename with the VSIX version you downloaded. The `code` command must be available on your PATH. To replace an already installed copy, you can add `--force`.

VSIX installations from GitHub Releases generally require manually downloading and installing newer versions. The VSIX contains the extension, not the DeepLocal model service.

## Features

- Use discovered local DeepLocal models or a remote OpenAI-compatible API.
- Chat in the dedicated DeepLocal sidebar, which can be moved to VS Code's
  Secondary Side Bar.
- Run coding tasks with workspace-aware tools for reading, searching, editing,
  creating, opening, and trashing individual files, as well as running commands.
- Review file changes before approval, with a diff preview where available.
- Review staged, unstaged, or committed Git changes in a dedicated read-only mode.
- Choose an approval mode: approve every operation, automatically allow safe
  operations, allow all operations, or use discussion-only mode.
- View streamed progress updates, tool activity, and final answers separately.
- Copy completed assistant answers, including folded code, using the copy icon below each reply. A checkmark and “Copied” confirm success briefly.
- Use the Responses API with compatible endpoints to display provider reasoning
  summaries separately from the answer.
- Keep recent chat sessions per workspace across webview recreation and reloads.

## Requirements

- VS Code 1.104 or later.
- Node.js and npm to build, test, or package the extension.
- For the default local backend, a running [DeepLocal service](https://github.com/petertzy/deepLocal)
  exposing an OpenAI-compatible API. Its default URL is
  `http://127.0.0.1:14567/v1`.

The remote backend is optional. It works with an OpenAI-compatible service and
may incur charges from that provider.

## Parallel read-only research

Enable `deeplocal.subagents.enabled` to let the agent delegate bounded research
tasks. Children use the selected model and backend; remote requests may incur
charges. Each child receives bounded context and may only use `read_file`,
`search_workspace`, `list_workspace_files`, and `get_diagnostics` within its
assigned paths. Children cannot run commands, edit files, or delegate further.
Research requires a local workspace and rejects symbolic links and junctions.
On supported POSIX platforms, scoped reads use descriptor-relative traversal so
concurrent path substitutions cannot redirect a child outside its assigned
workspace paths. Platforms without this primitive fail closed for scoped reads.

The parent waits for the research batch before continuing. Named expandable
cards show queued, working, and terminal states, model findings, observed
evidence, and limitations. Successful sibling findings remain visible when a
child fails, reaches a deadline or allowance, or is cancelled. **Stop** cancels active
children, queued work, and pending approvals. Saved sessions retain the research
cards and their attribution. Copying a child result preserves its identity,
evidence, limitations, and `testsRun: false`.

Discovery is bounded and reports incomplete candidate coverage. File evidence
is checked again before accepting a result; findings describe observed content
and can become stale after later edits. Child deadlines include approval waits;
batch deadlines also include queue time. Restarted sessions mark unfinished
children as interrupted instead of resuming them.

Research findings do not establish passed command verification. Tests are not
run by children; the parent's existing command verification behavior still
applies. Token allowances reserve API generation ceilings across requests;
they are bounds, not exact billed token counts.

| Setting | Default | Purpose |
| --- | --- | --- |
| `deeplocal.subagents.enabled` | `false` | Explicit opt-in to parallel read-only research subagents. |
| `deeplocal.subagents.maxConcurrent` | `2` | Concurrent research children, up to 4. |
| `deeplocal.subagents.maxTasks` | `6` | Maximum children across all batches in one primary Agent request. |
| `deeplocal.subagents.maxTurns` | `8` | Maximum model turns per child. |
| `deeplocal.subagents.timeoutMs` | `120000` | Per-child deadline in milliseconds. |
| `deeplocal.subagents.batchTimeoutMs` | `300000` | Entire research batch deadline in milliseconds. |
| `deeplocal.subagents.maxOutputTokens` | `8192` | Cumulative generation allowance per child. |
| `deeplocal.subagents.totalOutputTokens` | `32768` | Cumulative generation allowance across all children in one primary Agent request. |

## Commands

- **deeplocal-chat-adapter: Open** — Reveal the sidebar.
- **deeplocal-chat-adapter: New Session** — Start a sidebar session.
- **deeplocal-chat-adapter: Refresh Models** — Refresh the active backend's
  discovered models.
- **deeplocal-chat-adapter: Check Connection** — Validate the active backend's
  models endpoint.
- **deeplocal-chat-adapter: Test Remote API Request** — Test remote streamed
  chat generation without tools.
- **deeplocal-chat-adapter: Open Settings** — Open this extension's settings.
- **deeplocal-chat-adapter: Set Remote API Key** / **Clear Remote API Key** —
  Manage the remote credential in SecretStorage.

## Development and tests

```bash
npm run check
```

This runs TypeScript checking, linting, and unit tests. Additional commands:

- `npm run watch` — Watch the bundle and type checks.
- `npm run test:watch` — Watch unit tests.
- `npm run test:webview` — Run browser tests for the sidebar. Run
  `npx playwright install chromium` once if Chromium is not installed.
- `npm run test:integration` — Compile and launch an isolated VS Code Extension
  Host against a local fake OpenAI-compatible server.
- `npm run package` — Build the production bundle.
- `npm run package:vsix` — Create a distributable VSIX.

Unit, webview, and integration tests do not require a live DeepLocal service or
a billable remote API key.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
validation, and pull request guidance.

## License

MIT. See [LICENSE](LICENSE).
