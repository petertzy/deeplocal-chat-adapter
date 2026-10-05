# deeplocal-chat-adapter

`deeplocal-chat-adapter` is a VS Code extension that integrates local OpenAI-compatible DeepLocal models and models from other providers into the VS Code chat model picker and its built-in sidebar chat view.

<img width="1435" height="736" alt="Image" src="https://github.com/user-attachments/assets/90e35788-3ab3-4342-9211-15f7a2f8992d" />
<br>
<img width="1437" height="738" alt="Image" src="https://github.com/user-attachments/assets/64afc29a-32dd-4a6c-844b-379beafe91cc" />

## Quick Start & Testing (Debug Mode)
To quickly test and experience the extension's features during development:

   1. Open the project in VS Code.
   2. Press F5 (or go to the Run and Debug view and click Start Debugging).
   3. A new Extension Development Host window will open.
   4. In the new window, open the VS Code Chat view (or use the built-in sidebar chat) to see and test the deeplocal-chat-adapter integration immediately!

## Features

- Use DeepLocal models from VS Code.
- Chat in the DeepLocal view; move it to the Secondary Side Bar for a right-side layout.
- Create and edit files by path in the default Agent mode, with inline approval and diff previews.
- Follow streamed progress updates around Agent tool calls. Updates expand while streaming, collapse before operations, and remain in task history in chronological order; the final answer appears separately. These are model-written action summaries, available when the model emits commentary, rather than hidden internal reasoning.
- Display provider reasoning summaries separately when using a compatible Responses API model, in both Agent and Chat modes.
- Automatically follow Chinese/English conversation with localized sidebar controls, progress labels, operation titles and approval prompts; no language selector or setup is needed.
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
working. It has a high safety guard of 100 tool-use turns by default, capped at
1000 when configured, so ordinary tasks do not stop at a low arbitrary step
count; if the guard is reached it reports incomplete work rather than claiming
success.
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

## Reasoning summaries and display language

Open the sidebar **Settings → API protocol** and select **Responses** for a
provider/model that supports `/responses`. Leave **Reasoning summaries** enabled
to request `reasoning.summary: "auto"`. This uses the same streaming inference
request as the answer and tool calls; there is no second summarization request.
The sidebar shows separate **Reasoning summary**, **Progress update**, tool
activity and final-answer entries. Summaries remain available in history and
partial summaries survive cancellation or stream errors. Providers may return
no summary, even when one was requested; the UI does not invent one.

Chat Completions remains the default for existing local and remote setups.
If a Responses model rejects summaries, turn summaries **Off**. If the service
does not implement Responses, select **Chat Completions** to keep the existing
progress-and-tools workflow. Errors explain these choices; requests are not
silently retried against another endpoint. The settings are
`deeplocal.apiMode`, `deeplocal.remote.apiMode` and `deeplocal.reasoningSummary`.
Summary rendering is a sidebar feature; the VS Code language-model provider
continues to emit its standard text and tool-call parts.

Responses requests use `store: false` and replay complete output items,
including encrypted reasoning state and assistant phases, for continued tool
use. These items are retained in the workspace's chat history and sent back
only to the same backend URL/model. They are not displayed or logged. Changing
provider/model keeps ordinary messages and tool results but omits that opaque
state. The adapter displays only provider summary text, not raw reasoning
events. See [OpenAI's reasoning summary documentation](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries).

Language follows the conversation automatically, initially using VS Code's
language (Chinese or English fallback). Short or ambiguous replies inherit the
conversation language; fenced code, quoted lines, URLs and paths do not change
it. You can also say “reply in English” or “请用中文回答” directly in the chat.
Session switching and restoration recover the language from that conversation.
There is no language selector. The former `deeplocal.displayLanguage` setting
is no longer read, so an old manual choice cannot override automatic detection.
Other interface languages are not yet translated. Model progress and answers
are prompted to follow the user's language, including languages beyond these
two. Provider summaries are shown as received; their language is controlled by
the model and is not guaranteed. Code, paths, model IDs, raw tool output and
provider diagnostics are kept verbatim. Automatic localization changes interface
copy, not the content of previous messages.

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
`openai` and `openai-compatible` protocol hints, plus the selected
`chat-completions` or `responses` protocol. Endpoint hints must match the selected
API mode (`/chat/completions` or `/responses`, optionally prefixed with `/v1`). Other declared
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
