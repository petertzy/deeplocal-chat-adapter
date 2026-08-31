# DeepLocal Chat Adapter

DeepLocal Chat Adapter is a small VS Code extension that exposes local DeepLocal models to VS Code chat through the language model provider API.

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
DeepLocal: Open Chat
```

## Settings

- `deeplocal-chat.baseUrl`: DeepLocal API base URL
- `deeplocal-chat.apiKey`: optional Bearer token
- `deeplocal-chat.requestTimeout`: request timeout in milliseconds
- `deeplocal-chat.enableToolCalling`: forward chat tools to DeepLocal
- `deeplocal-chat.injectSystemPrompt`: prepend a compact coding-assistant instruction
