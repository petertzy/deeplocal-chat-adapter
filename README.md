# deeplocal-chat-adapter

`deeplocal-chat-adapter` is a VS Code extension that connects local DeepLocal
models and remote OpenAI-compatible APIs to VS Code chat. It provides a
sidebar for conversational coding tasks and registers discovered models in the
VS Code chat model picker.

![DeepLocal sidebar](https://github.com/user-attachments/assets/64afc29a-32dd-4a6c-844b-379beafe91cc)

![DeepLocal task view](https://github.com/user-attachments/assets/36a5d81c-5efb-493a-80aa-c7b072f9701f)

![DeepLocal extension screenshot](https://github.com/user-attachments/assets/0aaa5510-024a-418b-a7d5-82ee34789461)

## Install from VS Code Marketplace (recommended)

Install the extension directly from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=petertzy.deeplocal-chat-adapter), or open the **Extensions** view in VS Code and search for `@id:petertzy.deeplocal-chat-adapter`. Select **Install**.

The extension identifier is `petertzy.deeplocal-chat-adapter`. Marketplace installations support VS Code's built-in automatic extension updates when **Auto Update** is enabled. The first installation may prompt you to trust publisher `petertzy`; this is a normal VS Code security confirmation. Marketplace publication does not imply that the publisher has a verified badge.

After installation, run **deeplocal-chat-adapter: Open** from the Command Palette and [configure a backend](#configure-a-backend). The extension still requires a running local DeepLocal service or a compatible remote API.

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

## Maintainer release guide: Marketplace and GitHub Releases

**Use the publisher management page to update an existing extension.** The public
[Marketplace listing](https://marketplace.visualstudio.com/items?itemName=petertzy.deeplocal-chat-adapter)
is for installing and viewing the extension; it does **not** provide an update
button for maintainers.

| Purpose | URL |
| --- | --- |
| Install or view the extension | [Public Marketplace listing](https://marketplace.visualstudio.com/items?itemName=petertzy.deeplocal-chat-adapter) |
| Upload a new version | [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/) |
| Download or publish a VSIX release | [GitHub Releases](https://github.com/petertzy/deeplocal-chat-adapter/releases) |

The publisher ID is `petertzy`, and the full extension ID is
`petertzy.deeplocal-chat-adapter`. Keep `"publisher": "petertzy"` in
`package.json` for every release.

### Release checklist (example: 0.1.0 to 0.1.1)

1. Finish the code and documentation changes. Commit them, and ensure the Git
   working tree is clean. Check with `git status`. Confirm the current version
   and publisher in `package.json`.
2. Run `npm version patch` to increment `0.1.0` to `0.1.1`. By default,
   this updates `package.json` and `package-lock.json`, creates a Git commit,
   and creates the `v0.1.1` Git tag. Do **not** run it again for the same release
   or create a duplicate tag. For minor or major releases, use
   `npm version minor` or `npm version major` instead.
3. Run the checks and build the distributable VSIX:

   ```bash
   npm ci
   npm run check
   npm run package:vsix
   ```

   For version `0.1.1`, the expected output is
   `deeplocal-chat-adapter-0.1.1.vsix` in the repository root. Test the
   packaged extension in VS Code before publishing.
4. Push the release commit and its tag:

   ```bash
   git push origin main
   git push origin v0.1.1
   ```

   Replace `main` if releasing from a different branch. Confirm that the
   tag points to the source used to build the VSIX.
5. Open [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/),
   sign in, select **petertzy**, and find the existing
   **deeplocal-chat-adapter** extension. Open its **...** actions menu and
   choose **Update** (or the corresponding update/upload action). Upload
   `deeplocal-chat-adapter-0.1.1.vsix`. **Do not choose + New extension**:
   that is for creating a separate listing, not updating this one.
6. Wait until Marketplace verification finishes. Confirm that the existing
   extension shows version `0.1.1` and **Public** availability.
7. Open [GitHub Releases](https://github.com/petertzy/deeplocal-chat-adapter/releases),
   select **Draft a new release**, choose the existing `v0.1.1` tag, add
   English release notes, attach the **same**
   `deeplocal-chat-adapter-0.1.1.vsix`, and publish the release.
   Do not overwrite the previous `v0.1.0` release.
8. Verify the [public Marketplace listing](https://marketplace.visualstudio.com/items?itemName=petertzy.deeplocal-chat-adapter)
   and install or update the extension in VS Code. Marketplace-installed copies
   can receive VS Code automatic updates when **Auto Update** is enabled;
   manually installed GitHub VSIX copies generally require manual updates.

**Version consistency:** Each release should have matching `package.json`,
`package-lock.json`, Git tag, Marketplace version, and VSIX filename, all
built from the same committed source. `npm run package:vsix` only creates the
VSIX; it does not publish it. The original `v0.1.0` Git tag still contains
the old publisher value `local-dev`, even though the repackaged Marketplace
and GitHub VSIX uses `petertzy`. Preserve that published tag; ensure the next
release is consistent rather than force-moving old tags.

### Troubleshooting Marketplace publishing

- **No update button on the extension's public page:** Use the
  [publisher management page](https://marketplace.visualstudio.com/manage/publishers/),
  not the public listing. Open the existing extension's actions menu.
- **Version already exists or upload is rejected:** Increase the version,
  rebuild the VSIX, and upload the new package. Do not try to publish a new
  Marketplace version with the same version number.
- **Verifying status:** Wait for the Marketplace verification result before
  assuming the new version is publicly available.
- **No README available in VS Code immediately after publishing:** Check the
  [Marketplace web listing](https://marketplace.visualstudio.com/items?itemName=petertzy.deeplocal-chat-adapter).
  If the README is visible there, try **Developer: Reload Window** or wait
  for Marketplace metadata to propagate before rebuilding.
- **Trust publisher warning:** First-time installs may ask the user to trust
  publisher `petertzy`. This is a normal security prompt. Marketplace
  approval and publisher verification are separate.
- **Marketplace updates do not reach a manually installed VSIX:** Prefer
  installing from the Marketplace for built-in automatic updates.

## Build a VSIX without publishing

To build a VSIX for local testing without creating a new release:

```bash
npm ci
npm run check
npm run package:vsix
```

To install a generated VSIX manually, use **Extensions → ... → Install from
VSIX...** or run `code --install-extension ./deeplocal-chat-adapter-0.1.1.vsix`
with the filename adjusted to the version you built. The `code` command must
be available on your PATH.

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

In a multi-root window, use the **Workspace** button above the conversation to
choose the folder for agent operations. The picker shows each folder's URI to
distinguish duplicate names. A single open folder is selected automatically;
with several folders, choose one before sending an agent task. Cancelling the
picker keeps the previous choice. The choice lasts until the extension reloads.

The selected folder stays visible and cannot be changed while a task runs.
Removing that folder stops the task; already applied changes are retained.
File discovery, summaries, diagnostics, editor context, relative tool paths and
command working directories use the selected folder. Absolute paths and URI
inputs are rejected by file tools. Conversation history is retained when you
change folders. Existing symlink following and command permissions are unchanged;
the folder selection is not an operating-system sandbox.

Tool activity labels show only the action and a short target. Recognized sensitive
filenames (such as `.env`, credential files and private keys), authorization text,
credential assignments/options and URL credentials are replaced with
`[sensitive target redacted]` before the label is shortened. Ordinary paths and
search terms remain visible. Recognizable sensitive labels in saved activity are
also redacted when displayed again. These are limited presentation rules, not a
complete secret scanner; approval prompts, tool results and model conversation
history retain their existing behavior.

`read_file` reads UTF-8 text. Files containing NUL bytes or invalid UTF-8 return
an error identifying the workspace-relative path instead of their contents.

TypeScript file edits (`.ts`, `.tsx`, `.mts`, and `.cts`, including declaration
files) reject new or worsened duplicate import bindings before approval or saving.
The agent should inspect existing imports and runtime usages and make targeted
changes rather than adding equivalent imports.

After an approved TypeScript edit is saved, the extension compares available VS
Code diagnostics in the selected workspace. It reports newly observed, resolved,
and remaining diagnostics, including errors in already diagnosed dependent files.
New errors are returned to the agent for repair; the saved edit is retained.
Existing approval modes and command permissions still apply. Builds, lint, and
tests run only through the normal agent command flow.

Diagnostic observation waits up to two seconds and is best effort: VS Code does
not identify which document version a diagnostic update checked. Missing or
unsettled updates, unavailable providers, and concurrent edits make verification
inconclusive. An empty snapshot does not prove compilation succeeded. Diagnostics
depend on the project's installed language/lint providers and configuration;
closed files may not have diagnostics. Shell commands bypass the file-tool import
guard. Use relevant project checks before considering a fix complete.

To try these checks with a repeatable local demo, run:

```bash
npm run demo:edit-validation
```

The launcher builds the extension and opens an isolated VS Code window with a
disposable TypeScript workspace and a local scripted provider. No API key or
running model is needed. Wait for the ready message, select
`issue80-scripted-demo` in the DeepLocal sidebar, keep **Build / Ask** and
**Safe auto** selected, and send **Run demo**. The provider attempts duplicate
imports, introduces runtime misuse of type-only imports, and then repairs them.
Expand the tool cards and inspect `game.ts` and the Problems panel. The initial
TS2322 error and the first two failed tool cards are intentional. Choose
**Approve every action** before sending the prompt to also inspect approvals
and diff previews.

Actual tool feedback and pass/fail evidence are saved to `demo-results.json`
beside the demo workspace under `.vscode-test/issue80-demo/`. Close the demo
window and rerun the command for a fresh fixture. The first run may download the
same VS Code 1.104.0 used by the integration tests. This demo does not install
or publish the extension.

For automatic verification without mouse input, run
`npm run demo:edit-validation -- --verify`. This uses the real HTTP client,
agent loop, file tools, and TypeScript diagnostics, with the webview transport
captured for assertions; it closes the isolated window after checking all three
scenarios. The interactive command uses the actual DeepLocal sidebar.

Use **Stop** to cancel the active request or pending approval. Changes already
applied before cancellation remain in place.

The sidebar stores up to 20 recent sessions for each workspace in VS Code
`workspaceState`. Each stored session retains recent conversation history and
its rendered transcript. Empty VS Code windows share one session scope because
they do not have a durable workspace identity.

**Task history** shows each session title followed by a short preview of its
latest user request. Long previews are shortened without splitting Unicode
characters; the full preview is available in the selector's tooltip and each
option's accessible label. Empty sessions keep their title alone.

### Sidebar placement

The Open command reveals the sidebar at its saved VS Code location. To put it
on the right, right-click the DeepLocal view title and select **Move View →
Secondary Side Bar**. If necessary, first run **View: Toggle Secondary Side Bar
Visibility** from the Command Palette.

## Review code changes

Choose **Review** in the sidebar, select a model with tool calling, and choose
**Unstaged**, **Staged**, or **Commit range**. A written prompt is optional;
use it to focus the review on a particular concern. For a commit range, enter
base and target refs (hashes, branches, or tags). The defaults are `HEAD~1` and
`HEAD`; the review compares those two commits directly, without computing a
merge base.

Review mode inspects changes, surrounding source, and relevant tests. It cannot
edit files, run commands, or execute tests, even when **Full access** is selected.
It uses its own review context rather than replaying normal agent instructions.
Switching back to **Build / Ask** requires confirmation; fixes must be requested as a
new normal-mode task and follow the selected approval setting.
Starting or switching tasks keeps Review active until you explicitly leave it.

Reports separate confirmed findings from potential risks and include severity
(Critical, High, Medium, or Low), explanation, and verbatim source evidence.
Source buttons open a read-only copy of the reviewed content, including deleted
or historical lines. The copy icon below the report copies it as Markdown for you
to paste into a pull request; it does not connect to or post on GitHub. Completed
reports are retained in the existing workspace session history.

Git must be available, and the selected local workspace folder must be inside a
complete Git repository. Partial/promisor clones are rejected because reading
missing objects can trigger a fetch. Repository-configured executable Git helpers
are disabled during review; any disabled content filters are reported as a
limitation. Reviews cover tracked, saved files only: untracked files and
unsaved editor buffers are excluded. Staged reviews inspect index content;
commit reviews inspect the selected revisions. An unstaged review is rejected
if its underlying changes or inspected saved files change before completion.
Binary and submodule contents are reported as limitations. Diffs and individual
source files are limited to 60,000 characters; oversized diffs require a narrower
comparison. Search is bounded and reports skipped or truncated evidence.

Empty diffs do not make a model request. Empty findings do not guarantee that
the changes are correct. Every report states that tests were not run.

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
