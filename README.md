# DeepLocal

DeepLocal is a small VS Code extension that exposes local DeepLocal models inside VS Code.

The default API endpoint is:

```text
http://127.0.0.1:14567/v1
```

## Expected DeepLocal API

DeepLocal should provide an OpenAI-compatible surface:

- `GET /v1/models`
- `POST /v1/chat/completions`

Streaming chat responses should be sent as server-sent events using `data: {...}` lines and a final `data: [DONE]` marker.

## Development

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch an Extension Development Host. After DeepLocal is running, select a DeepLocal model in the chat model picker.

Use the DeepLocal view in the Secondary Side Bar to open the built-in chat view. You can also focus it from the command palette:

```text
DeepLocal: Open
```

## Install Locally In VS Code

Use this when you want to test the extension from VS Code's normal Extensions environment instead of the Extension Development Host.

```bash
npm run install:local
```

The script will install dependencies, build a VSIX package, and install it into VS Code with:

```bash
code --install-extension deeplocal-0.1.0.vsix --force
```

After installation, reload VS Code:

```text
Developer: Reload Window
```

Then open DeepLocal from the Extensions/Activity Bar entry, or run this command from the command palette:

```text
DeepLocal: Open
```

If the `code` command is not available, open VS Code and run:

```text
Shell Command: Install 'code' command in PATH
```

## Settings

- `deeplocal.baseUrl`: DeepLocal API base URL
- `deeplocal.apiKey`: optional Bearer token
- `deeplocal.requestTimeout`: request timeout in milliseconds
- `deeplocal.enableToolCalling`: forward editor tools to DeepLocal
- `deeplocal.injectSystemPrompt`: prepend a compact assistant instruction
