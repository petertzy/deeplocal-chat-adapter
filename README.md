# deeplocal-chat-adapter

`deeplocal-chat-adapter` is a VS Code extension that integrates local OpenAI-compatible DeepLocal models and models from other providers into the VS Code chat model picker and its built-in sidebar chat view.

<img width="1435" height="736" alt="Image" src="https://github.com/user-attachments/assets/90e35788-3ab3-4342-9211-15f7a2f8992d" />
<br>
<img width="1437" height="738" alt="Image" src="https://github.com/user-attachments/assets/64afc29a-32dd-4a6c-844b-379beafe91cc" />

## Features

- Use DeepLocal models from VS Code.
- Chat in the DeepLocal view; move it to the Secondary Side Bar for a right-side layout.
- Create and edit files by path in the default Agent mode, with inline approval and diff previews.
- Let capable models inspect files, search the workspace, read diagnostics, and propose confirmed edits.
- Restore recent chat sessions after reloading VS Code.

## Coding agent workflow

Open a project folder, choose a tool-capable model, and describe the task in the
sidebar. Agent mode is enabled by default. For example, ask “Create snake.html
with a playable snake game.” The agent inspects the workspace and calls
`create_file`; it no longer rewrites the request as an edit to the active editor.
`create_file` refuses to overwrite an existing file.

The Open command respects your saved view placement. On a fresh installation,
right-click the DeepLocal view title and choose **Move View → Secondary Side Bar**
if you prefer the right side. No proposed VS Code APIs are required.

The sidebar keeps task history and connection/API-key settings in panels opened
from the top toolbar. The bottom composer contains Agent/Chat mode, model
selection, and Send/Stop. Model selection and drafts survive webview recreation.
The conversation shows action cards with the operation, target path, and
working/done/failed/declined status. Long responses and code blocks are collapsed
by default, including during streaming; expand them when needed. Reading older
messages does not force-scroll back to the latest output.

File changes appear in a review card pinned above the composer. Use
**Preview diff**, then **Approve** or **Reject**. Approved changes are saved and
opened in the editor; command execution also requires approval. Tool results
are expandable and retained in the conversation. Existing unsaved edits and
files changed during review are protected. The agent uses results to continue
working and reports when it reaches its step limit rather than claiming success.
Create, modify, and delete are distinct actions. `delete_file` is reserved for an
explicit deletion request, requires approval, shows a deletion diff, and moves
one file to the trash. Directories and unsaved documents are rejected; an
unsupported trash operation is reported as an error, without a permanent-delete fallback.

**Stop** cancels the current request, pending approval, and a running command;
already applied changes remain. Session switching is disabled while working.
Choose Chat mode for discussion without tools. This workflow follows
[Cline's file review and tool execution approach](https://github.com/cline/cline#edits-code-across-your-project);
it does not include Cline's checkpoints, browser automation, or background terminals.
HTML files open in the editor; open the saved file in a browser to play the game.

## Chat session scope

Chat sessions are stored in VS Code `workspaceState`, so each folder or
multi-root workspace has its own session list and active session. Workspace
identity is derived from the workspace file when available, otherwise from all
workspace-folder URIs. Empty windows have no durable VS Code workspace identity
and therefore intentionally use the shared `empty` scope.

On upgrade, sessions written by versions before workspace scoping are migrated
once into the first workspace opened. The legacy global values are retained so
they remain recoverable; later workspaces start with a new session list. This
is the documented fallback because the old format did not record ownership.

## Requirements

Model discovery preserves optional `/models` hints: `max_input_tokens` (or
`context_length`), `max_output_tokens`, `capabilities.tool_calling` (or
`supports_tool_calls`), `protocol`, and `endpoint`. Positive integer limits and
boolean capability hints override the configured defaults. Missing or invalid
hints use `deeplocal.maxInputTokens`, `deeplocal.maxOutputTokens`, and
`deeplocal.enableToolCalling`; disable the latter for a conservative fallback
when the server provides no tool metadata. The model tooltip explains this
fallback. Image input remains disabled because this adapter sends text only.

Models explicitly lacking tool support remain available for plain chat; the
sidebar reports the reason and asks you to select Chat mode or a tool-capable model. The adapter supports the
`openai`, `openai-compatible`, and `chat-completions` protocol hints and the
`/chat/completions` or `/v1/chat/completions` endpoint hints. Other declared
protocols/endpoints produce a clear error before sending. Metadata never
redirects credentials or requests to another URL.

Before using the extension, start the separate local DeepLocal service and keep it running:

```text
https://github.com/petertzy/deepLocal
```

## Backend configuration

**Check Connection** validates the effective `<base URL>/models` endpoint and
succeeds only for a non-empty `data` array whose entries have non-empty string
IDs. A configured remote model fallback does not count as a successful check.
The base URL must use HTTP(S) and contain no embedded credentials, query, or
fragment; store credentials using the API-key control instead. Diagnostic
messages distinguish configuration, network, timeout, HTTP, JSON, schema, and
empty-model failures, show the checked endpoint, and offer **Open Settings**.
Response bodies, authorization headers, and transport exception details are
excluded from check diagnostics. The timeout covers both headers and body.
This check validates model discovery; use **Test Remote API Request** to verify
remote chat generation separately.

Streamed tool calls are assembled independently by index and delivered in index
order after completion. Text accompanying tool deltas is preserved. A missing
index is accepted for a single call or when its ID identifies an existing call;
ambiguous parallel deltas produce an error. Tool arguments must be a complete
JSON object (use `{}` for tools with no arguments). Invalid arguments, missing
IDs/names, interrupted streams, and truncated finish reasons prevent tool
execution. Errors retain streamed text and omit raw argument payloads.

Local DeepLocal remains the default backend at `http://127.0.0.1:14567/v1`. The extension contributes one VS Code chat provider named **DeepLocal / OpenAI-compatible**; its models are labeled `deeplocal` locally and `openai` remotely in the model picker. Use **deeplocal-chat-adapter: Open Settings** and set `deeplocal.backend` to `remote` to use an OpenAI-compatible API. The sidebar's **Change** button also switches the backend. Configure `deeplocal.remote.baseUrl` (default `https://api.openai.com/v1`) and `deeplocal.remote.model` (default `gpt-4.1-mini`), then run **deeplocal-chat-adapter: Set Remote API Key**. The key is stored in VS Code SecretStorage and is not part of settings or the repository. Run **Check Connection** to verify the selected backend. Set `deeplocal.backend` back to `local` to return to DeepLocal.

Remote API requests may incur provider charges. Use **deeplocal-chat-adapter: Test Remote API Request** to send a minimal streaming chat request without tools; this helps distinguish endpoint/model compatibility from tool-schema issues. Remote access is optional; automated tests use a fake OpenAI-compatible server and never require a real API key or make billable requests. Model discovery uses `/v1/models`; if it is unavailable, the configured remote model remains selectable for manual use.

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

   This installs dependencies, builds a VSIX package, and installs it into your normal VS Code installation. For development, use the faster workflow in [Contributing](CONTRIBUTING.md).

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

## Open The Right Sidebar

1. Open the Command Palette:

   - macOS: `Command+Shift+P`
   - Windows/Linux: `Ctrl+Shift+P`

2. Run:

   ```text
   deeplocal-chat-adapter: Open
   ```

The chat view opens at its saved location. To use VS Code's Secondary Side Bar (the right sidebar), move the DeepLocal view there. If the right sidebar is hidden:

1. Open the Command Palette:

   - macOS: `Command+Shift+P`
   - Windows/Linux: `Ctrl+Shift+P`

2. Run:

   ```text
   View: Toggle Secondary Side Bar Visibility
   ```

3. If the `deeplocal-chat-adapter` view is still on the left side, drag it from the left sidebar to the right sidebar.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and pull request guidance.

## License

MIT. See [LICENSE](LICENSE).
