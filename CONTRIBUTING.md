# Contributing

Thanks for helping improve `deeplocal-chat-adapter`.

Repository: https://github.com/petertzy/deeplocal-chat-adapter

## Getting Started

1. Clone this repository and open it locally:

   ```bash
   git clone https://github.com/petertzy/deeplocal-chat-adapter.git
   cd deeplocal-chat-adapter
   ```

2. Start the separate local DeepLocal service and keep it running:

   ```text
   https://github.com/petertzy/deepLocal
   ```

   The extension expects DeepLocal to expose an OpenAI-compatible API at:

   ```text
   http://127.0.0.1:14567/v1
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Build the extension:

   ```bash
   npm run compile
   ```

5. Open the repository in VS Code.

6. Press `F5` to launch an Extension Development Host.

7. In the Extension Development Host, open the Command Palette:

   - macOS: `Command+Shift+P`
   - Windows/Linux: `Ctrl+Shift+P`

8. Run:

   ```text
   deeplocal-chat-adapter: Open
   ```

9. Choose a DeepLocal model from the VS Code chat model picker.

## Opening The Right Sidebar

Run `deeplocal-chat-adapter: Open` from the Command Palette to open the chat view in VS Code's Secondary Side Bar.

If the right sidebar is hidden, run this command from the Command Palette:

```text
View: Toggle Secondary Side Bar Visibility
```

After installing the extension, reload VS Code first:

```text
Developer: Reload Window
```

## Quick Local Install

Use the local install script when you want to test the extension in your normal VS Code window instead of the Extension Development Host:

```bash
npm run install:local
```

You can also run the script directly:

```bash
./scripts/install-local.sh
```

The script installs dependencies, builds a VSIX package, and installs `local-dev.deeplocal-chat-adapter` into VS Code. After it finishes, reload VS Code from the Command Palette with:

```text
Developer: Reload Window
```

## Useful VS Code Commands

To run any VS Code command, open the Command Palette first:

- macOS: `Command+Shift+P`
- Windows/Linux: `Ctrl+Shift+P`

Common commands while developing:

- `deeplocal-chat-adapter: Open`
- `deeplocal-chat-adapter: New Session`
- `Developer: Reload Window`
- `Shell Command: Install 'code' command in PATH`

## Before You Open A Pull Request

Please run:

```bash
npm run compile
```

If your change affects packaging or installation, also run:

```bash
npm run package
```

## Contribution Guidelines

- Keep changes focused and easy to review.
- Follow the existing TypeScript style and VS Code extension patterns.
- Update documentation when behavior, commands, settings, or setup steps change.
- Include screenshots or short notes for visible UI changes.
- Avoid committing generated `.vsix` packages or local editor settings.

## Reporting Issues

When reporting a bug, include:

- VS Code version
- Node.js and npm versions
- DeepLocal API URL or relevant configuration
- Steps to reproduce
- Expected behavior and actual behavior
- Any relevant output logs
