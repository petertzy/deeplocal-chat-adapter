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

## Quick Start

1. Clone this repository and open it locally:

   ```bash
   git clone https://github.com/petertzy/deeplocal-chat-adapter.git
   cd deeplocal-chat-adapter
   ```

2. Run the quick install script from this repository:

   ```bash
   npm run install:local
   ```

   This installs dependencies, builds a VSIX package, and installs the extension into VS Code.

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
