
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

`run_command` returns JSON for both successful and failed processes: command,
arguments, selected working directory, exit code or signal, separate stdout and
stderr, duration, timeout/cancellation/output-limit flags, and a truncation flag.
Startup errors (such as a missing executable) have an `error` code and message.
The same result reaches the model and the expandable tool activity, including
partial output after a timeout or Stop. Existing approval rules still apply.

Commands keep the two-minute deadline and one-MiB capture ceiling per stream.
Exceeding a capture ceiling stops the child and explicitly marks incomplete
output. Displayed results reserve space for both streams and retain their start
and tail; each stream has a 10,000-character JSON-encoding budget. An incomplete
line at a capture boundary is omitted before redaction. Recognized credential
assignments/options, authorization/cookie headers, URL credentials, common token
prefixes and private-key blocks are redacted before shortening or persistence.
Sensitive argument lists are replaced as a whole. These are finite diagnostic
rules, not a scanner for arbitrary unlabelled or encoded secrets. Approval prompts
and original model-supplied arguments keep their existing behavior. Commands run
without an implicit shell; the workspace directory is not an OS sandbox, and
stopping a child does not provide process-tree isolation.

Agent tasks finish with `submit_completion`, listing the exact executable and
arguments for requested verification commands, including checks not run. The host
derives the displayed states from this task's recorded tools; it never accepts a
model-supplied pass/fail value. An unstructured model answer becomes an unverified
report, even if no tools ran. Chat and Ask-only responses keep ordinary prose.
The report is copied, saved and restored with the same evidence.

`checks_passed` covers only the declared commands, not all project problems.
All tool attempts remain inspectable, including undeclared failures and earlier
retries. A requested check absent from the attempts is not run; the extension does
not infer a verification plan from an undeclared command. Later file
mutation attempts conservatively invalidate earlier checks. A saved edit or
settled editor diagnostics alone never proves a successful build; commands may
also change files, and external edits are outside this task-local observation.
Truncated/incomplete results cannot certify a check. Stops, stream errors and
turn-limit exhaustion retain a partial report without starting a repair loop.

For coding tasks, the existing agent loop inspects project scripts and chooses
relevant checks. Commands marked with `verification: true` supply verification
metadata; the host derives their outcome from recorded command evidence. Failed
lint and build checks remain independent, so a passing build cannot clear a lint
failure. File edits make earlier verification stale and require fresh checks.

The `discover_verification_commands` tool reads manifests in the selected workspace,
including nested packages, and reports candidate lint, type-check, build, and test
commands without executing them. It prefers existing package scripts and also
recognizes common Rust, Go, Python, Maven, and Gradle configuration. The agent
selects checks relevant to its changes; discovery is not an instruction to run
every project check. Missing categories and known unsafe scripts are reported.
Lint, type checking, builds, and tests retain their own recorded outcomes.

Set `deeplocal.verificationPreferences` to a list such as `["lint", "typecheck", "test"]`
to limit suggestions, including per-workspace-folder preferences. The default
empty list discovers all available categories. Safe approval mode also inspects
package-script delegation and lifecycle hooks before execution. Unsafe or
uninspectable package invocations and opaque shell wrappers require approval;
Full access and Ask-only modes retain their existing behavior. These checks use
finite heuristics, not a sandbox for arbitrary project code.

After failed or missing verification, the agent can inspect the failure, make
targeted repairs and rerun the relevant checks. A repair cycle can include
multiple file edits and verification commands; lint, build and test commands do
not each consume a separate cycle. A further repair edit after rechecking starts
the next cycle. Premature completion submissions can prompt another repair;
repeated premature completions also consume the allowance. Inspection and editing
tool calls remain bounded by `deeplocal.agentMaxTurns`.
`deeplocal.agentMaxRepairIterations` defaults
to `3` and accepts integers from `0` through `20`; `0` disables automatic repair
while preserving accurate evidence. The overall turn limit still applies.
Repair stops after two consecutive identical diagnostics; denied approvals are
not retried automatically. Explanation-only requests do not trigger automatic
checks. Passing recorded checks proves only those checks passed, not that the
entire task is complete.

Progress and suggested next steps follow the user's conversational language;
fixed report labels/state names currently use English, like the surrounding UI.
Suggestions and model-stated reasons are unchecked text. They appear in a
separate, initially collapsed disclosure labelled as unverified model suggestions,
not completion evidence. Canonical copy and saved/restored history retain the
same explicit model-source/unverified wrapper; this text never determines check
states. Evidence uses the existing finite diagnostic redaction rules; it is not
a scanner for arbitrary secrets.

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
| `deeplocal.agentMaxRepairIterations` | `3` | Maximum verification repair cycles, from 0 through 20; 0 disables automatic repair while retaining accurate evidence. |
| `deeplocal.verificationPreferences` | `[]` | Limit suggested verification categories to `lint`, `typecheck`, `build`, and/or `test`; an empty list discovers all available categories. |
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

