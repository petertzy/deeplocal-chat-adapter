import { test, expect, Page } from '@playwright/test';
import { renderChatHtml } from '../../src/chat-webview';

declare global {
  interface Window {
    __messages: Array<Record<string, unknown>>;
    __state: Record<string, unknown>;
    acquireVsCodeApi: () => unknown;
  }
}

async function dispatch(page: Page, message: Record<string, unknown>) {
  await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), message);
}

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => {
    window.__messages = [];
    window.__state = {};
    window.acquireVsCodeApi = () => ({
      postMessage: (message: Record<string, unknown>) => window.__messages.push(message),
      getState: () => window.__state,
      setState: (state: Record<string, unknown>) => { window.__state = state; },
    });
  });
  await page.setContent(renderChatHtml({ cspSource: 'https://webview.test' }));
  await dispatch(page, { type: 'models', models: ['gpt-6-luna', 'local-model'], backend: 'remote', hasApiKey: true, baseUrl: 'https://api.example.test/v1' });
  await dispatch(page, { type: 'sessions', activeSessionId: 'one', sessions: [{ id: 'one', title: 'New task' }] });
});

test('compact default layout at narrow widths; settings are secondary and keyboard accessible', async ({ page }, testInfo) => {
  for (const width of [260, 340, 480]) {
    await page.setViewportSize({ width, height: 820 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const composer = await page.locator('footer').boundingBox();
    expect(composer!.height).toBeLessThan(250);
    await expect(page.locator('#settingsPanel')).toBeHidden();
    await expect(page.locator('#remoteKeyRow')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Send task', exact: true })).toBeDisabled();
  }
  await page.setViewportSize({ width: 340, height: 820 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#remoteKeyStatus')).toHaveText('API key configured');
  await page.keyboard.press('Escape');
  await expect(page.locator('#settingsPanel')).toBeHidden();
  await expect(page.locator('#prompt')).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('empty-dark.png') });
});

test('folds source code safely while streaming and keeps approval controls visible', async ({ page }, testInfo) => {
  await page.locator('#prompt').fill('Create snake.html');
  await page.locator('#send').click();
  await dispatch(page, { type: 'assistantStart' });
  const code = '<script>window.compromised = true</script>\n'.repeat(250);
  await dispatch(page, { type: 'assistantDelta', text: 'Building the game.\n```html\n' + code });
  await expect(page.locator('.code summary')).toContainText('Code · html');
  await expect(page.locator('.code')).not.toHaveAttribute('open');
  expect(await page.evaluate(() => 'compromised' in window)).toBe(false);
  await dispatch(page, { type: 'toolStart', activity: { id: 'c1', title: 'Create file', detail: 'snake.html', state: 'running' } });
  await dispatch(page, { type: 'approval', approvalId: 'a1', message: 'Create snake.html (250 lines)', hasPreview: true });
  await expect(page.locator('#review')).toBeInViewport();
  await expect(page.locator('#approve')).toBeInViewport();
  await expect(page.locator('#historyButton')).toBeDisabled();
  await page.locator('#preview').click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'preview', approvalId: 'a1' });
  await page.screenshot({ path: testInfo.outputPath('review-dark.png') });
  await page.locator('#approve').click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'approval', approved: true });
  await dispatch(page, { type: 'approvalDone', approvalId: 'a1', approved: true });
  await dispatch(page, { type: 'toolResult', text: 'create_file\nCreated snake.html.', activity: { id: 'c1', title: 'Create file', detail: 'snake.html', state: 'success' } });
  await dispatch(page, { type: 'assistantFinal', text: 'Created snake.html. Open it in a browser to play.' });
  await dispatch(page, { type: 'assistantDone', outcome: 'success' });
  await expect(page.locator('.action')).toHaveCount(1);
  await expect(page.locator('.action-state')).toHaveText('Done');
  await expect(page.locator('#messages > :last-child')).toContainText('Open it in a browser');
  await expect(page.locator('#status')).toHaveText('Task completed');
  await expect(page.locator('#review')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('completed-dark.png') });
});

test('shows concise progress before its operation and keeps it collapsible', async ({ page }) => {
  await dispatch(page, { type: 'assistantStart', agent: true });
  await dispatch(page, { type: 'reasoningStart' });
  await dispatch(page, { type: 'reasoningDelta', text: 'I will inspect the existing configuration before changing it.' });
  await dispatch(page, { type: 'toolStart', activity: { id: 'read1', title: 'Read file', detail: 'src/config.ts', state: 'running' } });
  const progress = page.locator('.reasoning');
  await expect(progress).toContainText('Progress update');
  await expect(progress).toContainText('inspect the existing configuration');
  await expect(progress).not.toHaveAttribute('open');
  expect(await progress.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('.action')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await progress.locator('summary').click();
  await expect(progress.locator('.prose')).toBeVisible();
  await dispatch(page, { type: 'reasoningStart' });
  await dispatch(page, { type: 'reasoningDelta', text: 'The configuration is ready.' });
  await dispatch(page, { type: 'assistantFinal', text: 'The configuration is ready.' });
  await dispatch(page, { type: 'assistantDone', outcome: 'success' });
  await expect(page.locator('.reasoning')).toHaveCount(1);
  await expect(page.locator('.assistant')).toHaveText('AgentThe configuration is ready.');
  await expect(page.locator('.reasoning')).not.toContainText('The configuration is ready.');
});

test('preserves model selection, supports Chat mode and does not submit IME composition', async ({ page }) => {
  await page.locator('#model').selectOption('local-model');
  await dispatch(page, { type: 'models', models: ['gpt-6-luna', 'local-model'], backend: 'remote', hasApiKey: true });
  await expect(page.locator('#model')).toHaveValue('local-model');
  await page.locator('#chatMode').click();
  await page.locator('#prompt').fill('你好');
  await page.locator('#prompt').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  expect(await page.evaluate(() => window.__messages.some(message => message.type === 'send'))).toBe(false);
  await page.locator('#prompt').press('Enter');
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'send', useAgent: false, model: 'local-model', text: '你好' });
  await dispatch(page, { type: 'assistantStart' });
  await page.locator('#stop').click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'stop' });
  await dispatch(page, { type: 'assistantDone', outcome: 'cancelled' });
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#stop')).toBeHidden();
});

test('preserves progress across multiple operations, interruption and history restore', async ({ page }) => {
  await dispatch(page, { type: 'assistantStart', agent: true });
  // Deliver boundaries within one frame to catch pending-render ordering bugs.
  await page.evaluate(() => {
    for (const data of [
      { type: 'reasoningStart' },
      { type: 'reasoningDelta', text: 'Inspecting the file.' },
      { type: 'toolStart', activity: { id: 'one', title: 'Read file', state: 'running' } },
      { type: 'reasoningStart' },
      { type: 'reasoningDelta', text: 'Checking the result. <script>unsafe()</script>' },
      { type: 'assistantDone', outcome: 'cancelled' },
    ]) window.dispatchEvent(new MessageEvent('message', { data }));
  });
  await expect(page.locator('.reasoning .prose')).toHaveText(['Inspecting the file.', 'Checking the result. <script>unsafe()</script>']);
  await expect(page.locator('#messages script')).toHaveCount(0);
  await expect(page.locator('#status')).toContainText('Stopped');
  await dispatch(page, { type: 'restore', items: [
    { role: 'Reasoning', text: 'Inspecting the file.' },
    { role: 'Tool', text: 'read_file\nRead file.', activity: { id: 'one', title: 'Read file', state: 'success' } },
    { role: 'Reasoning', text: 'Checking the result.' },
  ] });
  await expect(page.locator('#messages > details')).toHaveClass(['reasoning', 'action', 'reasoning']);
  await expect(page.locator('.reasoning[open]')).toHaveCount(0);
});

test('restores action states and folds historical code in a light theme', async ({ page }, testInfo) => {
  await page.addStyleTag({ content: ':root { --vscode-foreground: #333; --vscode-sideBar-background: #f8f8f8; --vscode-editor-background: white; --vscode-input-background: white; --vscode-input-foreground: #333; --vscode-input-border: #ccc; --vscode-descriptionForeground: #666; --vscode-panel-border: #ddd; --vscode-dropdown-background: white; --vscode-textCodeBlock-background: #eee; --vscode-button-secondaryBackground: #ddd; --vscode-button-secondaryForeground: #333; --vscode-badge-background: #eee; --vscode-badge-foreground: #333; }' });
  await dispatch(page, { type: 'restore', items: [
    { role: 'You', text: 'Create a Snake game' },
    { role: 'Tool', text: 'create_file\nCreated snake.html.', activity: { id: 'old1', title: 'Create file', detail: 'snake.html', state: 'success' } },
    { role: 'Tool', text: 'run_command\nUser declined command execution.', activity: { id: 'old2', title: 'Run command', detail: 'npm test', state: 'declined' } },
    { role: 'DeepLocal', text: 'Created the file. Tests were not run.\n```html\n<html>example</html>\n```' },
  ] });
  await expect(page.locator('.action-state')).toHaveText(['Done', 'Declined']);
  await expect(page.locator('.code')).not.toHaveAttribute('open');
  await page.locator('.code summary').click();
  await expect(page.locator('.code pre')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('restored-light.png') });
});

test('does not force-scroll away from a reader inspecting earlier messages', async ({ page }) => {
  await dispatch(page, { type: 'restore', items: Array.from({ length: 24 }, (_, i) => ({ role: 'You', text: 'Earlier task ' + i })) });
  await page.locator('#messages').evaluate(node => { node.scrollTop = 0; });
  await dispatch(page, { type: 'assistantStart' });
  await dispatch(page, { type: 'assistantDelta', text: 'Working on the next step.' });
  await page.waitForTimeout(50);
  expect(await page.locator('#messages').evaluate(node => node.scrollTop)).toBe(0);
});

test('rejects deletion explicitly and preserves partial text and draft after a failure', async ({ page }) => {
  await page.locator('#prompt').fill('Delete obsolete.html');
  await page.locator('#send').click();
  await dispatch(page, { type: 'assistantStart' });
  await dispatch(page, { type: 'toolStart', activity: { id: 'delete1', title: 'Delete file', detail: 'obsolete.html', state: 'running' } });
  await dispatch(page, { type: 'approval', approvalId: 'delete-approval', message: 'Delete obsolete.html (move to trash)', hasPreview: true });
  await page.locator('#reject').click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'approval', approvalId: 'delete-approval', approved: false });
  await dispatch(page, { type: 'approvalDone', approvalId: 'delete-approval', approved: false });
  await dispatch(page, { type: 'toolResult', text: 'delete_file\nUser declined file deletion.', activity: { id: 'delete1', title: 'Delete file', detail: 'obsolete.html', state: 'declined' } });
  // Deliver all three events before the next animation frame.
  await page.evaluate(() => {
    for (const data of [{ type: 'assistantDelta', text: 'The file was kept.' }, { type: 'error', message: 'Connection interrupted.' }, { type: 'assistantDone', outcome: 'error' }]) {
      window.dispatchEvent(new MessageEvent('message', { data }));
    }
  });
  await expect(page.locator('.action-state')).toHaveText('Declined');
  await expect(page.locator('.assistant')).toContainText('The file was kept.');
  await expect(page.locator('#prompt')).toHaveValue('Delete obsolete.html');
  await expect(page.locator('#status')).toHaveText('Needs attention');
  await expect(page.locator('#send')).toBeEnabled();
});
