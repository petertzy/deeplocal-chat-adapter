# deeplocal-chat-adapter

`deeplocal-chat-adapter` is a VS Code extension that connects local OpenAI-compatible DeepLocal models to the VS Code chat model picker and a built-in sidebar chat view.

<img width="1430" height="683" alt="Image" src="https://github.com/user-attachments/assets/ecb5554a-578b-4ff5-ba57-fa93b4edc0e6" />

## Features

- Use DeepLocal models from VS Code.
- Chat in the DeepLocal Secondary Side Bar view.
- Edit the active file with confirmation before changes are applied.
- Let capable models inspect files, search the workspace, read diagnostics, and propose confirmed edits.
- Restore recent chat sessions after reloading VS Code.

## Requirements

Before using the extension, start the separate local DeepLocal service and keep it running:

```text
https://github.com/petertzy/deepLocal
```

That service should expose an OpenAI-compatible API at:

```text
http://127.0.0.1:14567/v1
```

The extension uses:

- `GET /v1/models`
- `POST /v1/chat/completions`

Streaming responses should use server-sent events with `data: {...}` lines and a final `data: [DONE]` marker.

## Quick Start

1. Clone this repository and open it locally:

   ```bash
   git clone https://github.com/petertzy/deeplocal-chat-adapter.git
   cd deeplocal-chat-adapter
   ```

2. Start the separate local DeepLocal service and keep it running:

   ```text
   https://github.com/petertzy/deepLocal
   ```

3. Install dependencies and build this extension:

   ```bash
   npm install
   npm run compile
   ```

4. Open this folder in VS Code.

5. Press `F5` to launch an Extension Development Host.

6. In the Extension Development Host, open the Command Palette:

   - macOS: `Command+Shift+P`
   - Windows/Linux: `Ctrl+Shift+P`

7. Run:

   ```text
   deeplocal-chat-adapter: Open
   ```

8. Select a DeepLocal model in the VS Code chat model picker.

## Open The Right Sidebar

1. Open the Command Palette:

   - macOS: `Command+Shift+P`
   - Windows/Linux: `Ctrl+Shift+P`

2. Run:

   ```text
   deeplocal-chat-adapter: Open
   ```

The chat view opens in VS Code's Secondary Side Bar, which is the right sidebar. If the right sidebar is hidden, open the Command Palette and run:

```text
View: Toggle Secondary Side Bar Visibility
```

After installing the extension, reload VS Code first:

```text
Developer: Reload Window
```

## Local Install

Use this when you want to test the extension in your normal VS Code window instead of the Extension Development Host.

1. Start the local DeepLocal service and keep it running.

2. Install this extension into VS Code with the quick local install script:

   ```bash
   npm run install:local
   ```

   You can also run the script directly:

   ```bash
   ./scripts/install-local.sh
   ```

The script installs dependencies, builds a VSIX package, and installs it into VS Code with the `code` command. If `code` is not available, run this command in VS Code first:

1. Open the Command Palette:

   - macOS: `Command+Shift+P`
   - Windows/Linux: `Ctrl+Shift+P`

2. Run:

   ```text
   Shell Command: Install 'code' command in PATH
   ```

Reload VS Code after installation:

1. Open the Command Palette:

   - macOS: `Command+Shift+P`
   - Windows/Linux: `Ctrl+Shift+P`

2. Run:

   ```text
   Developer: Reload Window
   ```

3. Open the Command Palette again and run:

   ```text
   deeplocal-chat-adapter: Open
   ```

## Development

Useful commands:

```bash
npm run compile
npm run watch
npm run package
npm run package:vsix
```

Before opening a pull request, please run:

```bash
npm run compile
```

## Settings

- `deeplocal.baseUrl`: DeepLocal API base URL
- `deeplocal.apiKey`: optional Bearer token
- `deeplocal.requestTimeout`: request timeout in milliseconds
- `deeplocal.maxInputTokens`: advertised maximum input tokens
- `deeplocal.maxOutputTokens`: advertised maximum output tokens
- `deeplocal.enableToolCalling`: expose editor tools to compatible models
- `deeplocal.injectSystemPrompt`: prepend a compact assistant instruction
- `deeplocal.agentMaxTurns`: maximum tool-use turns for one agent request
- `deeplocal.logLevel`: extension output logging level

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and pull request guidance.

## License

MIT. See [LICENSE](LICENSE).
