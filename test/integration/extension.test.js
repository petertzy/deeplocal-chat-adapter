const assert = require('node:assert/strict');
const http = require('node:http');
const vscode = require('vscode');

suite('deeplocal-chat-adapter Extension Host', () => {
  let server;
  let baseUrl;
  let modelRequests = 0;

  suiteSetup(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/v1/models') {
        modelRequests += 1;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'integration-model' }] }));
      } else {
        response.statusCode = 404;
        response.end('not found');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('deeplocal').update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('discovers and activates despite the unavailable default DeepLocal endpoint', async () => {
    const extension = vscode.extensions.getExtension('local-dev.deeplocal-chat-adapter');
    assert.ok(extension, 'extension should be discovered by its manifest');
    await extension.activate();
    assert.equal(extension.isActive, true);
    await vscode.workspace.getConfiguration('deeplocal').update(
      'baseUrl', 'http://127.0.0.1:1/v1', vscode.ConfigurationTarget.Global,
    );
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'deeplocal-chat-adapter.open', 'deeplocal-chat-adapter.newSession',
      'deeplocal-chat-adapter.refreshModels', 'deeplocal-chat-adapter.checkConnection',
    ]) assert.ok(commands.includes(command), `${command} should be registered`);
    assert.ok(vscode.extensions.all.find((candidate) => candidate.id === extension.id));
    // The command catches server errors and leaves the extension usable.
    await vscode.commands.executeCommand('deeplocal-chat-adapter.refreshModels');
    await vscode.workspace.getConfiguration('deeplocal').update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('deeplocal-chat-adapter.refreshModels');
    assert.ok(modelRequests > 0, 'extension should communicate with the fake OpenAI models endpoint');
    const models = await vscode.lm.selectChatModels({ vendor: 'deeplocal-chat-adapter' });
    assert.ok(models.some((model) => model.id === 'integration-model'), 'language model provider should expose discovered models');
    assert.ok(extension.packageJSON.contributes.views['deeplocal-chat-adapter-sidebar']
      .some((view) => view.id === 'deeplocal-chat-adapter.view'), 'webview view should be contributed');
  });
});
