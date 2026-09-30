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

## Backend configuration

Local DeepLocal remains the default backend at `http://127.0.0.1:14567/v1`. The extension contributes one VS Code chat provider named **DeepLocal / OpenAI-compatible**; its models are labeled `deeplocal` locally and `openai` remotely in the model picker. Use **deeplocal-chat-adapter: Open Settings** and set `deeplocal.backend` to `remote` to use an OpenAI-compatible API. The sidebar's **Change** button also switches the backend. Configure `deeplocal.remote.baseUrl` (default `https://api.openai.com/v1`) and `deeplocal.remote.model` (default `gpt-4.1-mini`), then run **deeplocal-chat-adapter: Set Remote API Key**. The key is stored in VS Code SecretStorage and is not part of settings or the repository. Run **Check Connection** to verify the selected backend. Set `deeplocal.backend` back to `local` to return to DeepLocal.

Remote API requests may incur provider charges. Remote access is optional; automated tests use a fake OpenAI-compatible server and never require a real API key or make billable requests. Model discovery uses `/v1/models`; if it is unavailable, the configured remote model remains selectable for manual use.

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

The chat view opens in VS Code's Secondary Side Bar, which is the right sidebar. If the right sidebar is hidden:

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
