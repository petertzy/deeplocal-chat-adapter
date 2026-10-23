const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const model = 'issue80-scripted-demo';
const original = [
  "import { FoodRenderer, SnakeRenderer } from './renderers';",
  "import type { SettingsManager, ScoreManager } from './renderers';",
  'export const food = new FoodRenderer();',
  'export const snake = new SnakeRenderer();',
  'export interface Managers { settings: SettingsManager; score: ScoreManager }',
  '// Intentional starting error: the demo fixes this, then catches new errors.',
  'export const status: string = 123;',
  '',
].join('\n');
const duplicate = original + "import type { FoodRenderer, SnakeRenderer, SettingsManager, ScoreManager } from './renderers';\n";
const badImport = "import type { FoodRenderer, SnakeRenderer, SettingsManager, ScoreManager } from './renderers';";
const goodImport = "import { FoodRenderer, SnakeRenderer } from './renderers';\nimport type { SettingsManager, ScoreManager } from './renderers';";
const runtimeError = original.replace(goodImport, badImport).replace('status: string = 123', "status: string = 'ready'");
const repaired = runtimeError.replace(badImport, goodImport);
const renderers = ['FoodRenderer', 'SnakeRenderer', 'SettingsManager', 'ScoreManager']
  .map(name => `export class ${name} {}`).join('\n') + '\n';

function reply(response, text, tool) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = { content: text };
  if (tool) delta.tool_calls = [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }];
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
}

/** A scripted provider, not a model: every success depends on real tool feedback. */
async function createDemoServer(workspace, onRecord = () => {}) {
  const records = [];
  const report = path.join(path.dirname(workspace), 'demo-results.json');
  let queue = Promise.resolve();
  const server = http.createServer((request, response) => {
    queue = queue.then(async () => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: model, capabilities: { tool_calling: true } }] }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404); response.end('Not found'); return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const messages = body.messages ?? [];
      const start = messages.findLastIndex(message => message.role === 'user');
      if (!/^run demo[.!]?$/i.test(String(messages[start]?.content ?? '').trim()) || !body.tools?.length) {
        reply(response, 'This is the scripted issue #80 demo provider. Use Build / Ask with Safe auto (or Approve every action), select issue80-scripted-demo, and send exactly: Run demo. Restart the launcher for a fresh run.');
        return;
      }
      const results = messages.slice(start + 1).filter(message => message.role === 'tool');
      const stage = results.length;
      const last = results.at(-1)?.content ?? '';
      const save = async (step, passed, details) => {
        const record = { step, passed, details };
        records.push(record);
        await fs.writeFile(report, JSON.stringify({ scriptedProvider: true, workspace, records }, null, 2));
        onRecord(record);
      };
      try {
        if (stage === 0) {
          reply(response, 'Step 1/3: I will read the fixture, then attempt the duplicate-import mistake from issue #80.',
            { id: 'demo-read', name: 'read_file', args: { path: 'game.ts' } });
        } else if (stage === 1) {
          assert.equal(last, original, 'The starting fixture changed. Restart the launcher for a fresh demo.');
          reply(response, 'Step 1/3: This intentionally bad edit adds conflicting imports for all four classes. The extension should reject it before writing.',
            { id: 'demo-duplicate', name: 'write_file', args: { path: 'game.ts', content: duplicate } });
        } else if (stage === 2) {
          assert.match(last, /No change applied: new or worsened duplicate import bindings/);
          for (const name of ['FoodRenderer', 'SnakeRenderer', 'SettingsManager', 'ScoreManager']) assert.ok(last.includes(name), `Missing conflict: ${name}`);
          assert.equal(await fs.readFile(path.join(workspace, 'game.ts'), 'utf8'), original, 'The rejected edit changed the file.');
          await save('Duplicate imports blocked; original file unchanged', true, last);
          reply(response, 'Step 1 passed: all four conflicting bindings were blocked and the file is unchanged. Step 2/3: I will fix the original TS2322 error but deliberately make the runtime classes type-only. Watch for new TS1361 errors.',
            { id: 'demo-runtime', name: 'write_file', args: { path: 'game.ts', content: runtimeError } });
        } else if (stage === 3) {
          assert.match(last, /saved and retained/);
          assert.match(last, /1361/);
          assert.match(last, /new: 2 errors/);
          assert.match(last, /resolved: 1 errors/);
          assert.equal(await fs.readFile(path.join(workspace, 'game.ts'), 'utf8'), runtimeError, 'The faulty saved edit was not retained.');
          await save('New runtime errors surfaced despite resolving the original error; saved edit retained', true, last);
          reply(response, 'Step 2 passed: the original error disappeared, but two new TS1361 errors were returned to me. The edit was saved and retained. Step 3/3: I will repair only the import declaration, keeping runtime classes as values.',
            { id: 'demo-repair', name: 'replace_in_file', args: { path: 'game.ts', oldText: badImport, newText: goodImport } });
        } else if (stage === 4) {
          assert.match(last, /new: 0 errors/);
          assert.match(last, /remaining: 0 errors/);
          assert.match(last, /resolved: 2 errors/);
          assert.doesNotMatch(last, /inconclusive/i);
          assert.equal(await fs.readFile(path.join(workspace, 'game.ts'), 'utf8'), repaired);
          await save('Targeted import repair saved; both runtime errors resolved', true, last);
          reply(response, 'All three demo checks passed.\n\n1. Duplicate imports were rejected before saving.\n2. New runtime errors were reported even though the original error was fixed; the saved edit remained available for repair.\n3. A targeted import repair resolved both runtime errors.\n\nInspect the tool cards, game.ts, and the Problems panel. The observed diagnostics are best effort, not a build guarantee. Actual tool feedback is saved in demo-results.json next to this disposable workspace. Restart the launcher to replay.');
        } else {
          reply(response, 'The scripted demo has ended. Restart the launcher to replay it in a fresh workspace.');
        }
      } catch (error) {
        await save(`Demo stopped at stage ${stage}`, false, `${error.message}\nActual tool feedback:\n${last}`);
        reply(response, `Demo verification stopped: ${error.message}\n\nThis is not a passing result. Inspect the tool feedback and demo-results.json. If diagnostics were inconclusive, allow TypeScript to initialize and restart the launcher.`);
      }
    }).catch(error => {
      if (!response.headersSent) response.writeHead(500);
      response.end(error.message);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, report, records,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

module.exports = { model, original, duplicate, runtimeError, repaired, renderers, createDemoServer };
