const assert = require('node:assert/strict');
const http = require('node:http');
const vscode = require('vscode');
const path = require('node:path');
const { buildSync } = require('esbuild');

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
    const { publisher, name } = require('../../package.json');
    const extension = vscode.extensions.getExtension(`${publisher}.${name}`);
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
    assert.ok(extension.packageJSON.contributes.viewsContainers.activitybar
      .some((container) => container.id === 'deeplocal-chat-adapter-sidebar'), 'container must use a stable contribution point');
    await vscode.commands.executeCommand('deeplocal-chat-adapter.open');
  });

  test('uses a single workspace folder automatically without selection', async () => {
    buildSync({ entryPoints: [path.join(__dirname, '../../src/agent-tools.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['vscode', 'koffi'], outfile: path.join(__dirname, '../../out/single-workspace-tools.cjs') });
    const { invokeAgentTool } = require('../../out/single-workspace-tools.cjs');
    assert.equal(vscode.workspace.workspaceFolders.length, 1);
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'single.txt');
    await vscode.workspace.fs.writeFile(uri, Buffer.from('automatic single folder'));
    const result = await invokeAgentTool('single', 'read_file', '{"path":"single.txt"}');
    assert.equal(result.status, 'success');
    assert.equal(result.content, 'automatic single folder');
  });

  test('completion reports bind failed real commands and unexecuted builds to saved host evidence', async () => {
    buildSync({ entryPoints: [path.join(__dirname, '../../src/chat-panel.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['vscode', 'koffi'], outfile: path.join(__dirname, '../../out/completion-panel.cjs') });
    const { ChatPanel } = require('../../out/completion-panel.cjs');
    const config = vscode.workspace.getConfiguration('deeplocal');
    const oldMode = config.inspect('approvalMode')?.globalValue;
    const oldRepairLimit = config.inspect('agentMaxRepairIterations')?.globalValue;
    const values = new Map(), posts = [], requests = [], subscriptions = [];
    const memento = { get: (key, fallback) => values.get(key) ?? fallback,
      update: async (key, value) => { values.set(key, structuredClone(value)); } };
    const code = "process.stdout.write('src/main.ts:8 lint failure\\n');process.stderr.write('synthetic diagnostic');process.exitCode=1";
    const tool = (id, name, args) => ({ kind: 'toolCall', value: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } } });
    const responses = [
      [tool('lint82', 'run_command', { command: 'node', args: ['-e', code] })],
      [tool('completion82', 'submit_completion', { checks: [{ command: 'node', args: ['-e', code] }, { command: 'npm', args: ['run', 'build'] }], nextSteps: '请先修复错误，再运行构建。' })],
      [{ kind: 'text', value: 'All fixed and verified.' }],
    ];
    const client = { modelInformation: () => ({ toolCalling: true }), cancel() {},
      streamChat: async function* (_id, request) { requests.push(structuredClone(request)); yield* responses.shift() ?? []; } };
    let receive, dispose;
    const panel = new ChatPanel({ subscriptions, workspaceState: memento, globalState: memento }, client,
      { error() {} }, { get: async () => '', set: async () => {}, clear: async () => {} });
    try {
      await config.update('approvalMode', 'full', vscode.ConfigurationTarget.Global);
      await config.update('agentMaxRepairIterations', 0, vscode.ConfigurationTarget.Global);
      panel.resolveWebviewView({ onDidDispose: callback => { dispose = callback; }, webview: {
        cspSource: 'vscode-webview:', onDidReceiveMessage: callback => { receive = callback; },
        postMessage: message => { posts.push(message); return Promise.resolve(true); },
      } });
      const waitDone = async count => {
        const deadline = Date.now() + 10000;
        while (posts.filter(message => message.type === 'assistantDone').length < count) {
          assert.ok(Date.now() < deadline, 'completion must finish'); await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      receive({ type: 'send', text: 'Run lint and build; 请用中文回答。', model: 'synthetic' }); await waitDone(1);
      const final = posts.find(message => message.type === 'assistantFinal');
      const report = JSON.parse(final.text);
      assert.equal(report.verification, 'failed');
      assert.deepEqual(report.checks.map(check => check.state), ['failed', 'not_run']);
      assert.equal(report.attempts[0].exitCode, 1); assert.match(report.attempts[0].detail, /src\/main.ts:8/);
      assert.equal(report.unverifiedModelText.nextSteps, '请先修复错误，再运行构建。');
      assert.equal(report.unverifiedModelText.source, 'model'); assert.equal(report.unverifiedModelText.verified, false);
      const sessions = [...values.values()].find(Array.isArray);
      assert.deepEqual(sessions[0].transcript.at(-1).completionReport, report);
      assert.equal(sessions[0].history.at(-1).content, final.text);
      assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.content.includes('synthetic diagnostic')));
      receive({ type: 'switchSession', sessionId: sessions[0].id });
      const deadline = Date.now() + 3000;
      while (!posts.some(message => message.type === 'restore')) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.deepEqual(posts.find(message => message.type === 'restore').items.at(-1).completionReport, report);
      receive({ type: 'send', text: 'Explain the next step only', model: 'synthetic' }); await waitDone(2);
      const next = posts.filter(message => message.type === 'assistantFinal').at(-1);
      assert.equal(next.text, 'All fixed and verified.');
      assert.equal(next.completionReport, undefined);
    } finally {
      dispose?.(); for (const subscription of subscriptions) subscription.dispose();
      await config.update('approvalMode', oldMode, vscode.ConfigurationTarget.Global);
      await config.update('agentMaxRepairIterations', oldRepairLimit, vscode.ConfigurationTarget.Global);
    }
  });

  const toolEvent = (id, name, args) => ({ kind: 'toolCall', value: {
    id, type: 'function', function: { name, arguments: JSON.stringify(args) },
  } });

  async function repairPanel(responses, approvalMode = 'full', repairLimit = 3) {
    buildSync({ entryPoints: [path.join(__dirname, '../../src/chat-panel.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['vscode', 'koffi'], outfile: path.join(__dirname, '../../out/repair-panel.cjs') });
    delete require.cache[require.resolve('../../out/repair-panel.cjs')];
    const { ChatPanel } = require('../../out/repair-panel.cjs');
    const config = vscode.workspace.getConfiguration('deeplocal');
    const previous = ['approvalMode', 'agentMaxRepairIterations'].map(key => [key, config.inspect(key)?.globalValue]);
    await config.update('approvalMode', approvalMode, vscode.ConfigurationTarget.Global);
    await config.update('agentMaxRepairIterations', repairLimit, vscode.ConfigurationTarget.Global);
    const values = new Map(), posts = [], requests = [], subscriptions = [];
    const memento = { get: (key, fallback) => values.get(key) ?? fallback,
      update: async (key, value) => { values.set(key, structuredClone(value)); } };
    let receive, dispose, cancellations = 0;
    const client = { modelInformation: () => ({ toolCalling: true }), cancel() { cancellations++; },
      streamChat: async function* (_id, request) {
        requests.push(structuredClone(request));
        assert.ok(responses.length, 'host must stop after the scripted completion');
        yield* responses.shift();
      } };
    const panel = new ChatPanel({ subscriptions, workspaceState: memento, globalState: memento }, client,
      { error() {} }, { get: async () => '', set: async () => {}, clear: async () => {} });
    panel.resolveWebviewView({ onDidDispose: callback => { dispose = callback; }, webview: {
      cspSource: 'vscode-webview:', onDidReceiveMessage: callback => { receive = callback; },
      postMessage: message => { posts.push(message); return Promise.resolve(true); },
    } });
    return { posts, values, requests, send: message => receive(message), get cancellations() { return cancellations; },
      waitFor: async predicate => {
        const deadline = Date.now() + 15000;
        while (!predicate()) {
          assert.ok(Date.now() < deadline, 'repair task must finish');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      },
      close: async () => {
        dispose?.(); for (const subscription of subscriptions) subscription.dispose();
        for (const [key, value] of previous) await config.update(key, value, vscode.ConfigurationTarget.Global);
      } };
  }

  test('repairs a real failed marked lint check and reruns its exact command before completion', async () => {
    const file = 'repair79-lint.txt';
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, file);
    await vscode.workspace.fs.writeFile(uri, Buffer.from('bad-token\n'));
    const code = "const s=require('fs').readFileSync('repair79-lint.txt','utf8');if(s.includes('bad-token')){console.error('repair79-lint.txt:1:1 lint error bad-token');process.exitCode=1}else{console.log('lint passed')}";
    const command = { command: 'node', args: ['-e', code], verification: true };
    const harness = await repairPanel([
      [toolEvent('lint79a', 'run_command', command)],
      [toolEvent('submit79a', 'submit_completion', { checks: [], nextSteps: '' })],
      [toolEvent('inspect79', 'read_file', { path: file })],
      [toolEvent('repair79', 'replace_in_file', { path: file, oldText: 'bad-token', newText: 'good-token' })],
      [toolEvent('lint79b', 'run_command', command)],
      [toolEvent('submit79b', 'submit_completion', { checks: [], nextSteps: '' })],
    ]);
    try {
      harness.send({ type: 'send', text: 'Fix the lint failure and verify it.', model: 'synthetic' });
      await harness.waitFor(() => harness.posts.some(message => message.type === 'assistantDone'));
      const final = harness.posts.find(message => message.type === 'assistantFinal');
      assert.ok(final, 'host must emit a completion report');
      const report = final.completionReport;
      assert.equal(report.verification, 'checks_passed');
      assert.deepEqual(report.checks, [{ command: JSON.stringify(['node', '-e', code]), state: 'passed', attempts: ['lint79a', 'lint79b'] }]);
      assert.deepEqual(report.attempts.filter(attempt => attempt.tool === 'run_command').map(attempt => attempt.exitCode), [1, 0]);
      assert.match(report.attempts[0].detail, /lint error bad-token/);
      assert.ok(harness.requests[2].messages.some(message => typeof message.content === 'string' && message.content.includes('lint error bad-token')),
        'repair request must carry actual diagnostics');
      assert.equal(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(), 'good-token\n');
      assert.equal(report.attempts.find(attempt => attempt.id === 'repair79').saved, true);
      const session = [...harness.values.values()].find(Array.isArray)[0];
      assert.deepEqual(session.transcript.at(-1).completionReport, report);
      harness.send({ type: 'switchSession', sessionId: session.id });
      await harness.waitFor(() => harness.posts.some(message => message.type === 'restore'));
      assert.deepEqual(harness.posts.find(message => message.type === 'restore').items.at(-1).completionReport, report);
      assert.equal(harness.requests.length, 6);
    } finally { await harness.close(); await vscode.workspace.fs.delete(uri); }
  });

  for (const repairLimit of [1, 3]) {
    for (const firstCheck of ['lint', 'build']) {
      for (const batched of [true, false]) {
        const scenario = `limit${repairLimit}-${firstCheck}-first-${batched ? 'batch' : 'separate'}`;
        test(`one repair budget covers the complete verification suite: ${scenario}`, async () => {
          const file = `repair79-suite-${scenario}.txt`;
          const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, file);
          let harness;
          try {
            await vscode.workspace.fs.writeFile(uri, Buffer.from('bad-token\n'));
            const commands = {
              lint: { command: 'node', args: ['-e', `const text=require('fs').readFileSync(${JSON.stringify(file)},'utf8');if(text.includes('bad-token')){console.error('lint error: bad-token');process.exitCode=1}else{console.log('lint passed')}`], verification: true },
              build: { command: 'node', args: ['-e', "console.log('build passed')"], verification: true },
              test: { command: 'node', args: ['-e', "console.log('tests passed')"], verification: true },
            };
            const order = firstCheck === 'lint' ? ['lint', 'build', 'test'] : ['build', 'lint', 'test'];
            const callId = (name, phase) => `${scenario}-${name}-${phase}`;
            const checkTurns = phase => {
              const calls = order.map(name => toolEvent(callId(name, phase), 'run_command', commands[name]));
              return batched ? [calls] : calls.map(call => [call]);
            };
            const readId = `${scenario}-read`, editId = `${scenario}-edit`;
            const responses = [
              ...checkTurns('initial'),
              [toolEvent(readId, 'read_file', { path: file })],
              [toolEvent(editId, 'replace_in_file', { path: file, oldText: 'bad-token', newText: 'good-token' })],
              ...checkTurns('recheck'),
              [toolEvent(`${scenario}-submit`, 'submit_completion', {
                checks: order.map(name => ({ command: commands[name].command, args: commands[name].args })), nextSteps: '',
              })],
            ];
            const expectedRequests = responses.length;
            harness = await repairPanel(responses, 'full', repairLimit);
            harness.send({ type: 'send', text: 'Run lint, build and tests, fix the lint error, then rerun every check.', model: 'synthetic' });
            await harness.waitFor(() => harness.posts.some(message => message.type === 'assistantDone'));
            const final = harness.posts.find(message => message.type === 'assistantFinal');
            assert.ok(final?.completionReport, 'the full suite must produce a completion report');
            const report = final.completionReport;
            assert.equal(report.verification, 'checks_passed', 'one actual repair must fit within the repair budget');
            assert.equal(harness.requests.length, expectedRequests, 'host must reach all checks and the final submission');
            assert.deepEqual(report.checks, order.map(name => ({
              command: JSON.stringify([commands[name].command, ...commands[name].args]), state: 'passed',
              attempts: [callId(name, 'initial'), callId(name, 'recheck')],
            })));
            assert.deepEqual(report.attempts.map(attempt => attempt.id), [
              ...order.map(name => callId(name, 'initial')), readId, editId,
              ...order.map(name => callId(name, 'recheck')),
            ], 'every initial check and complete recheck suite must run around exactly one targeted repair');
            const commandAttempts = report.attempts.filter(attempt => attempt.tool === 'run_command');
            assert.deepEqual(commandAttempts.map(attempt => attempt.exitCode), [
              ...order.map(name => name === 'lint' ? 1 : 0), 0, 0, 0,
            ]);
            const edits = report.attempts.filter(attempt => attempt.tool === 'replace_in_file');
            assert.equal(edits.length, 1);
            assert.equal(edits[0].saved, true);
            assert.equal(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(), 'good-token\n');
            assert.equal(harness.posts.filter(message => message.type === 'assistantFinal').length, 1);
          } finally {
            if (harness) await harness.close();
            await vscode.workspace.fs.delete(uri);
          }
        });
      }
    }
  }

  for (const action of ['deny', 'stop']) {
    test(`pending verification approval ${action} never starts the command or repairs`, async () => {
      const file = `repair79-${action}-must-not-exist.txt`;
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, file);
      const command = { command: 'node', args: ['-e', `require('fs').writeFileSync(${JSON.stringify(file)},'started')`], verification: true };
      const harness = await repairPanel([
        [toolEvent('approval79', 'run_command', command)],
        [toolEvent('submit79', 'submit_completion', { checks: [], nextSteps: '' })],
      ], 'every');
      try {
        harness.send({ type: 'send', text: 'Run the marked verification command.', model: 'synthetic' });
        await harness.waitFor(() => harness.posts.some(message => message.type === 'approval'));
        const approval = harness.posts.find(message => message.type === 'approval');
        harness.send(action === 'stop' ? { type: 'stop' } : { type: 'approval', approvalId: approval.approvalId, approved: false });
        await harness.waitFor(() => harness.posts.some(message => message.type === 'assistantDone'));
        await assert.rejects(vscode.workspace.fs.stat(uri));
        assert.equal(harness.posts.filter(message => message.type === 'approval').length, 1);
        assert.ok(harness.requests.length <= 2, 'denial must not open a repair cycle');
        const report = harness.posts.find(message => message.type === 'assistantFinal')?.completionReport;
        assert.ok(report, 'stopped or declined verification must retain evidence');
        assert.notEqual(report.verification, 'checks_passed');
        assert.ok(report.limitation, 'host must explain the stop');
        if (action === 'stop') {
          assert.equal(harness.posts.find(message => message.type === 'assistantDone').outcome, 'cancelled');
          assert.equal(harness.cancellations, 1);
        } else assert.equal(report.checks[0].state, 'blocked');
      } finally { await harness.close(); }
    });
  }

  test('restores the latest request preview and selection without adding persisted fields', async () => {
    buildSync({ entryPoints: [path.join(__dirname, '../../src/chat-panel.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['vscode', 'koffi'], outfile: path.join(__dirname, '../../out/session-preview-panel.cjs') });
    const { ChatPanel, workspaceIdentity } = require('../../out/session-preview-panel.cjs');
    const scope = workspaceIdentity();
    const key = `deeplocal.sessions.${scope}`;
    const activeKey = `deeplocal.activeSessionId.${scope}`;
    const latest = 'Latest request\n日本語 👩🏽‍💻 <img src=x onerror="synthetic57()"> & "quotes"';
    const values = new Map([[activeKey, 'saved'], [key, [{
      id: 'saved', title: 'Existing title', updatedAt: 1,
      history: [{ role: 'user', content: 'First request' }, { role: 'user', content: latest }],
      transcript: [{ role: 'You', text: 'First request' }, { role: 'You', text: latest }, { role: 'Tool', text: 'Unrelated result' }],
    }, { id: 'empty', title: 'New session', updatedAt: 0, history: [], transcript: [] }]]]);
    const memento = { get: (key, fallback) => values.get(key) ?? fallback,
      update: async (key, value) => { values.set(key, structuredClone(value)); } };
    const requests = [];
    const client = { listModels: async () => [{ id: 'session-test' }], modelInformation: () => ({ toolCalling: true }), cancel() {},
      streamChat: async function* (_id, request) { requests.push(request); yield { kind: 'text', value: 'Synthetic answer' }; } };
    const subscriptions = [];
    const panels = [];
    const mount = () => {
      const posts = [];
      let receive, dispose;
      const panel = new ChatPanel({ subscriptions, workspaceState: memento, globalState: memento }, client, { error() {} },
        { get: async () => undefined, set: async () => {}, clear: async () => {} });
      panel.resolveWebviewView({ onDidDispose: callback => { dispose = callback; }, webview: {
        cspSource: 'vscode-webview:', onDidReceiveMessage: callback => { receive = callback; },
        postMessage: message => { posts.push(message); return Promise.resolve(true); },
      } });
      panels.push(() => dispose());
      return { posts, send: message => receive(message) };
    };
    const waitFor = async predicate => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('Timed out waiting for session messages');
    };
    try {
      const first = mount();
      first.send({ type: 'ready' });
      await waitFor(() => first.posts.some(message => message.type === 'sessions'));
      const summary = first.posts.find(message => message.type === 'sessions');
      assert.equal(summary.activeSessionId, 'saved');
      assert.equal(summary.sessions[0].preview, latest);
      assert.equal(summary.sessions[0].title, 'Existing title');
      assert.equal(summary.sessions[1].preview, '');
      const followup = 'Follow-up request with extra context';
      first.send({ type: 'send', text: followup, model: 'session-test', useAgent: false });
      await waitFor(() => first.posts.some(message => message.type === 'assistantDone'));
      assert.equal(first.posts.filter(message => message.type === 'sessions').at(-1).sessions[0].preview, followup);
      assert.equal(requests[0].messages.filter(message => message.role === 'user').at(-1).content, followup);
      first.send({ type: 'switchSession', sessionId: 'empty' });
      await waitFor(() => values.get(activeKey) === 'empty');
      const restored = mount();
      restored.send({ type: 'ready' });
      await waitFor(() => restored.posts.some(message => message.type === 'sessions'));
      const restoredSummary = restored.posts.find(message => message.type === 'sessions');
      assert.equal(restoredSummary.activeSessionId, 'empty');
      assert.equal(restoredSummary.sessions.find(session => session.id === 'saved').preview, followup);
      assert.equal(values.get(key).find(session => session.id === 'saved').title, 'Existing title');
      assert.ok(values.get(key).every(session => !('preview' in session)));
    } finally {
      for (const dispose of panels) dispose();
      for (const subscription of subscriptions) subscription.dispose();
    }
  });
});
