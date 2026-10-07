# deeplocal-chat-adapter

`deeplocal-chat-adapter` is a VS Code extension that connects local DeepLocal
models and remote OpenAI-compatible APIs to VS Code chat. It provides a
sidebar for conversational coding tasks and registers discovered models in the
VS Code chat model picker.

<img width="1437" height="738" alt="DeepLocal sidebar" src="https://github.com/user-attachments/assets/64afc29a-32dd-4a6c-844b-379beafe91cc" />
<br>
<img width="1309" height="737" alt="DeepLocal task view" src="https://github.com/user-attachments/assets/36a5d81c-5efb-493a-80aa-c7b072f9701f" />

## Quick Start & Testing (Debug Mode)

To quickly test the extension during development:

1. Open the project in VS Code.
2. Press `F5`, or open **Run and Debug** and select **Start Debugging**.
3. A new Extension Development Host window opens.
4. In that window, open the VS Code Chat view or the built-in sidebar chat to
   test the deeplocal-chat-adapter integration.

## Features

- Use discovered local DeepLocal models or a remote OpenAI-compatible API.
- Chat in the dedicated DeepLocal sidebar, which can be moved to VS Code's
  Secondary Side Bar.
- Run coding tasks with workspace-aware tools for reading, searching, editing,
  creating, opening, and trashing individual files, as well as running commands.
- Review file changes before approval, with a diff preview where available.
- Choose an approval mode: approve every operation, automatically allow safe
  operations, allow all operations, or use discussion-only mode.
- View streamed progress updates, tool activity, and final answers separately.
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

## Quick Start

1. Clone this repository and open it locally:

   ```bash
   git clone https://github.com/petertzy/deeplocal-chat-adapter.git
   cd deeplocal-chat-adapter
   ```

2. For the final packaged-extension install, run:

   ```bash
   npm run install:local
   ```

   This installs dependencies, builds a VSIX package, and installs it into your
   normal VS Code installation. The script requires the `code` command to be
   available in your shell. For development, use the debug workflow above or
   the guidance in [CONTRIBUTING.md](CONTRIBUTING.md).

   You can also run the script directly:

   ```bash
   ./scripts/install-local.sh
   ```

3. Open VS Code's Command Palette:

   - macOS: `Command+Shift+P`
   - Windows/Linux: `Ctrl+Shift+P`

4. Run:

   ```text
   Developer: Reload Window
   ```

5. Open the Command Palette again and run:

   ```text
   deeplocal-chat-adapter: Open
   ```

6. Select a DeepLocal model in the VS Code chat model picker.

## Use the sidebar

Open a project folder, run **deeplocal-chat-adapter: Open**, choose a model,
and enter a task. The selected approval mode determines whether the sidebar
operates as an agent or as a discussion-only chat.

| Mode | Behavior |
| --- | --- |
| **Approve every action** | Requests confirmation before every tool call, including read-only operations. |
| **Safe auto** (default) | Automatically performs ordinary workspace operations; asks before sensitive paths, potentially unsafe commands, and deletion. |
| **Full access** | Runs agent operations without approval prompts. Use only when you trust the task and model. |
| **Ask only** | Disables agent operations; use it for explanation and planning. |

Agent mode requires an open workspace folder and a model that advertises tool
calling support. The available tools can inspect the workspace, read files and
diagnostics, search, edit or create files, open files, run commands, and move a
single explicitly requested file to the system trash. Paths are restricted to
the workspace. `create_file` does not overwrite an existing file.

Use **Stop** to cancel the active request or pending approval. Changes already
applied before cancellation remain in place.

The sidebar stores up to 20 recent sessions for each workspace in VS Code
`workspaceState`. Each stored session retains recent conversation history and
its rendered transcript. Empty VS Code windows share one session scope because
they do not have a durable workspace identity.

### Sidebar placement

The Open command reveals the sidebar at its saved VS Code location. To put it
on the right, right-click the DeepLocal view title and select **Move View →
Secondary Side Bar**. If necessary, first run **View: Toggle Secondary Side Bar
Visibility** from the Command Palette.

## Configure a backend

The extension uses the local DeepLocal backend by default. Open the sidebar
settings and choose **Change** under Provider, or open
**deeplocal-chat-adapter: Open Settings** and set `deeplocal.backend`.

For a remote backend:

1. Set `deeplocal.backend` to `remote`.
2. Set `deeplocal.remote.baseUrl` and `deeplocal.remote.model` as needed.
3. Use **Set API key** in the sidebar or run
   **deeplocal-chat-adapter: Set Remote API Key**. The remote key is stored in
   VS Code SecretStorage, not in workspace settings.
4. Run **deeplocal-chat-adapter: Check Connection** to verify model discovery.
   Use **deeplocal-chat-adapter: Test Remote API Request** to test a minimal
   streamed request to the selected remote model.

Model discovery uses `<base URL>/models`. A remote backend falls back to the
configured `deeplocal.remote.model` when discovery is unavailable, but that
fallback does not make a connection check succeed. Local model discovery must
return models successfully.

| Setting | Default | Purpose |
| --- | --- | --- |
| `deeplocal.backend` | `local` | Selects the local DeepLocal or remote OpenAI-compatible backend. |
| `deeplocal.baseUrl` | `http://127.0.0.1:14567/v1` | Local API base URL. |
| `deeplocal.apiKey` | empty | Optional bearer token for the local API; stored as a machine-scoped setting. |
| `deeplocal.remote.baseUrl` | `https://api.openai.com/v1` | Remote API base URL. |
| `deeplocal.remote.model` | `gpt-4.1-mini` | Remote fallback model ID. |
| `deeplocal.apiMode` | `chat-completions` | Protocol used with the local backend. |
| `deeplocal.remote.apiMode` | `chat-completions` | Protocol used with the remote backend. |
| `deeplocal.reasoningSummary` | `auto` | Requests Responses API reasoning summaries when supported; set to `off` to disable them. |
| `deeplocal.requestTimeout` | `120000` | Request timeout in milliseconds. |
| `deeplocal.maxInputTokens` | `131072` | Fallback advertised maximum input tokens. |
| `deeplocal.maxOutputTokens` | `16384` | Fallback maximum output tokens. |
| `deeplocal.enableToolCalling` | `true` | Fallback tool-calling capability when model metadata does not specify it. |
| `deeplocal.injectSystemPrompt` | `true` | Adds the extension's compact coding-assistant prompt. |
| `deeplocal.agentMaxTurns` | `100` | Agent tool-use safety limit, configurable from 1 through 1000. |
| `deeplocal.approvalMode` | `safe` | Default approval behavior for sidebar agent tasks. |
| `deeplocal.logLevel` | `info` | Extension output logging level. |

Base URLs must use HTTP(S) and must not include embedded credentials, a query,
or a fragment. The connection check reports configuration, network, timeout,
HTTP, JSON, schema, or empty-model failures without exposing authorization
headers or response bodies.

## Protocols, model metadata, and reasoning summaries

**Chat Completions** is the default protocol. Select **Responses** only when
the selected backend and model support the Responses API. In Responses mode,
the extension can request `reasoning.summary: "auto"` and renders any provider
summary as a separate sidebar entry. Providers may return no summary. Disable
`deeplocal.reasoningSummary` for models that reject summaries.

Responses requests use `store: false`. To continue an agent task, the extension
keeps opaque Responses output items only in that workspace's chat history and
sends them back only to the same backend URL and model. Raw reasoning content
is neither displayed nor logged.

The extension reads optional `/models` metadata for input/output token limits,
tool-calling capability, protocol, and endpoint. Valid metadata overrides the
fallback settings above. Models without tool support remain available for
discussion-only chat. The adapter sends text input only; image input is not
supported.

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
