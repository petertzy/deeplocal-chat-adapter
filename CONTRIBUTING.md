# Contributing

Thanks for helping improve `deeplocal-chat-adapter`.

Repository: https://github.com/petertzy/deeplocal-chat-adapter

## Getting Started

1. Clone this repository and open it locally:

   ```bash
   git clone https://github.com/petertzy/deeplocal-chat-adapter.git
   cd deeplocal-chat-adapter
   ```

2. For manual feature testing, start the separate local DeepLocal service:

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

   Unit and integration tests use a local fake server and do not need DeepLocal installed.

   You can also run the script directly:

   ```bash
   ./scripts/install-local.sh
   ```

## Development And Testing

Run `npm run watch` in one terminal for continuous bundle and type checking. Run `npm run test:watch` in another for continuous unit tests.

- `npm test` runs fast unit tests in Node, without VS Code or a DeepLocal service.
- `npm run check` runs type checking, lint, and unit tests.
- `npm run test:integration` compiles the extension and launches an isolated VS Code Extension Host against a local fake OpenAI-compatible server.

For interactive manual testing, select **Run deeplocal-chat-adapter (Extension Development Host)** in VS Code's **Run and Debug** panel and choose **Start Debugging**. The same configuration is available with **Command Palette → Debug: Start Debugging**. It compiles the current source and opens a separate Extension Development Host with an isolated profile. This launch runs without an attached debugger, so it does not pause the extension host while waiting for a debugger connection. To use breakpoints, select **Debug deeplocal-chat-adapter (Extension Development Host)** instead.

Before release, `npm run package` builds production output, `npm run package:vsix` creates the distributable, and `npm run install:local` installs that VSIX in the normal VS Code installation for final packaged-extension validation.

After launching the development host, start DeepLocal if you want to test live model interactions and run `deeplocal-chat-adapter: Open` from its Command Palette.

## Opening The Right Sidebar

Run `deeplocal-chat-adapter: Open` from the Command Palette to open the chat view in VS Code's Secondary Side Bar.

If the right sidebar is hidden, run this command from the Command Palette:

```text
View: Toggle Secondary Side Bar Visibility
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

Please run the fast validation and Extension Host tests:

```bash
npm run check
npm run test:integration
```

Also verify release packaging when your change affects it:

```bash
npm run package
npm run package:vsix
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
