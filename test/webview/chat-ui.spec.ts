import { test, expect, Page } from '@playwright/test';
import { renderChatHtml } from '../../src/chat-webview';
import { toolActivity } from '../../src/tool-activity';
import { executeCommand } from '../../src/command-runner';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskEvidence, formatCompletion } from '../../src/task-evidence';

const reviewReport = {
  summary: 'Review completed.', label: 'HEAD~1..HEAD', testsRun: false, limitations: ['Only the selected changes were reviewed.'],
  sources: [{ path: 'src/old.ts', side: 'base', content: 'const unsafe = true;\n' }],
  findings: [{ title: 'Unsafe default', severity: 'High', classification: 'confirmed', explanation: 'The default bypasses the guard.',
    evidence: 'const unsafe = true;', path: 'src/old.ts', side: 'base', startLine: 1, endLine: 1 }],
};

const researchResult = {
  id: 'child-1', title: 'Inspect permissions', state: 'completed', testsRun: false,
  findings: [{ text: 'The guard rejects writes.', evidence: [{ observationId: 'observation-1', tool: 'read_file', path: 'src/guard.ts', quote: 'return false;' }] }],
  limitations: ['Only the assigned paths were read.'], durationMs: 250,
};

test('research cards keep unique child attribution across interleaved states and partial failure', async ({ page }, testInfo) => {
  const activity = { id: 'child-1', parentRequestId: 'request-1', title: 'Inspect permissions', state: 'queued' };
  await dispatch(page, { type: 'subagent', activity });
  await dispatch(page, { type: 'subagent', activity: { ...activity, id: 'child-2', title: 'Inspect limits', state: 'running' } });
  await expect(page.locator('.subagent .action-state')).toHaveText(['Queued', 'Working']);
  await dispatch(page, { type: 'subagent', activity: { ...activity, state: 'running' } });
  await dispatch(page, { type: 'subagent', activity: { ...activity, id: 'child-2', title: 'Inspect limits', state: 'failed', result: { ...researchResult, id: 'child-2', title: 'Inspect limits', state: 'failed', limitations: ['Backend failed after one observation.'] } } });
  await dispatch(page, { type: 'subagent', activity: { ...activity, state: 'completed', result: researchResult } });
  await expect(page.locator('.subagent')).toHaveCount(2);
  await expect(page.locator('.subagent .action-state')).toHaveText(['Completed', 'Failed']);
  const card = page.locator('.subagent').first();
  await card.locator('summary').click();
  await expect(card).toContainText('Research · child-1');
  await expect(card).toContainText('Model findings');
  await expect(card).toContainText('Observed evidence');
  await expect(card.locator('pre')).toHaveText('return false;');
  await expect(card).toContainText('Tests were not run by this subagent.');
  for (const width of [260, 340]) {
    await page.setViewportSize({ width, height: 980 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath('parallel-research-narrow.png') });
  await card.getByRole('button', { name: 'Copy assistant message', exact: true }).click();
  const copy = await page.evaluate(() => window.__messages.at(-1));
  expect(copy?.type).toBe('copy');
  expect(JSON.parse(String(copy?.text))).toMatchObject({ ...activity, state: 'completed', result: researchResult });
  await expect(card.locator('.message-actions')).toHaveCount(1);
});

test('restored research preserves cancellation, limits and safe text without stale cards', async ({ page }) => {
  const unsafe = '<img src=x onerror="window.compromised=true"> [execute](command:evil)';
  for (const state of ['cancelled', 'limited']) {
    const result = { ...researchResult, state, findings: [{ text: unsafe, evidence: [{ observationId: 'obs-unsafe', tool: 'read_file', path: unsafe, quote: unsafe }] }], limitations: [state === 'limited' ? 'Child deadline reached.' : 'Stopped by user.'] };
    const activity = { id: 'child-1', parentRequestId: 'request-saved', title: unsafe, state, result };
    await dispatch(page, { type: 'restore', items: [{ role: 'Tool', text: 'fallback must not render', subagent: activity }] });
    const card = page.locator('.subagent');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.action-title')).toHaveText(unsafe);
    await expect(card.locator('.action-state')).toHaveText(state === 'limited' ? 'Limit reached' : 'Cancelled');
    await card.locator('summary').click();
    await expect(card.locator('pre')).toHaveText(unsafe);
    await expect(card).toContainText(result.limitations[0]);
    await expect(card.locator('a, img, script')).toHaveCount(0);
    expect(await page.evaluate(() => 'compromised' in window)).toBe(false);
    await dispatch(page, { type: 'subagent', activity });
    await expect(card).toHaveCount(1);
    await expect(card.locator('.message-actions')).toHaveCount(1);
    await card.getByRole('button', { name: 'Copy assistant message', exact: true }).click();
    const copied = await page.evaluate(() => window.__messages.at(-1));
    expect(JSON.parse(String(copied?.text)).result).toEqual(result);
  }
  await dispatch(page, { type: 'restore', items: [] });
  await expect(page.locator('.subagent')).toHaveCount(0);
});

test('completion research is separate from command verification and shares one copy control', async ({ page }) => {
  const report = { verification: 'not established', scope: 'Current task', checks: [], attempts: [], notRecorded: 'No commands recorded.', research: [{ id: 'batch-1', state: 'partial', results: [researchResult, { ...researchResult, id: 'child-2', state: 'failed', limitations: ['Backend failed.'] }] }] };
  const text = JSON.stringify(report);
  await dispatch(page, { type: 'restore', items: [{ role: 'DeepLocal', text, completionReport: report }] });
  const completion = page.locator('.completion-report');
  await expect(completion).toContainText('Verification: not established');
  await expect(completion).toContainText('No verification checks declared');
  await completion.locator('.research-results > summary').click();
  await expect(completion).toContainText('Batch batch-1 — partial');
  await expect(completion.locator('.subagent')).toHaveCount(2);
  await completion.locator('.subagent').first().locator('summary').click();
  await expect(completion.locator('.subagent').first()).toContainText('Observed evidence');
  await expect(page.getByRole('button', { name: 'Copy assistant message', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Copy assistant message', exact: true }).click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'copy', text });
});

test('review workflow waits for host confirmation and keeps permissions separate', async ({ page }) => {
  await page.locator('#prompt').fill('Check the guard');
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).selectOption('review');
  expect(await page.evaluate(() => window.__messages.at(-1))).toEqual({ type: 'setWorkflow', workflow: 'review' });
  await expect(page.locator('#workflow')).toHaveValue('normal');
  await expect(page.locator('#workflow')).toBeDisabled();
  await expect(page.locator('#send')).toBeDisabled();
  await expect(page.locator('#reviewOptions')).toBeHidden();
  await dispatch(page, { type: 'workflow', workflow: 'review' });
  await expect(page.locator('#workflow')).toHaveValue('review');
  await expect(page.locator('#permissionMode')).toBeHidden();
  await expect(page.locator('#permissionMode')).toBeDisabled();
  await expect(page.locator('#modeHint')).toContainText('Read-only review');
  await page.locator('#workflow').selectOption('normal');
  await expect(page.locator('#workflow')).toHaveValue('review');
  await expect(page.locator('#send')).toBeDisabled();
  // Host declined leaving review, so no editing mode becomes authoritative.
  await dispatch(page, { type: 'workflow', workflow: 'review' });
  await expect(page.locator('#workflow')).toBeEnabled();
  await expect(page.locator('#permissionMode')).toBeHidden();
  await page.locator('#workflow').selectOption('normal');
  await dispatch(page, { type: 'workflow', workflow: 'normal' });
  await expect(page.locator('#permissionMode')).toBeVisible();
  await expect(page.locator('#permissionMode')).toBeEnabled();
  await expect(page.locator('#prompt')).toHaveValue('Check the guard');
});

test('review accepts empty focus with selected changes while normal tasks require text', async ({ page }) => {
  await expect(page.locator('#send')).toBeDisabled();
  await dispatch(page, { type: 'workflow', workflow: 'review' });
  await expect(page.getByRole('textbox', { name: 'Review focus (optional)', exact: true })).toBeVisible();
  await expect(page.locator('#reviewSource')).toHaveValue('unstaged');
  await expect(page.locator('#reviewCommits')).toBeHidden();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toEqual({ type: 'send', text: '', model: 'gpt-6-luna', review: { source: 'unstaged' } });
  await dispatch(page, { type: 'assistantDone', outcome: 'success', review: true });
  await page.locator('#reviewSource').selectOption('staged');
  await page.locator('#prompt').fill('Check error handling');
  await page.locator('#send').click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toEqual({ type: 'send', text: 'Check error handling', model: 'gpt-6-luna', review: { source: 'staged' } });
});

test('commit review fields fit narrow widths and submit the exact ref inputs', async ({ page }, testInfo) => {
  await dispatch(page, { type: 'workflow', workflow: 'review' });
  await page.locator('#reviewSource').selectOption('commits');
  await expect(page.getByRole('textbox', { name: 'Base ref', exact: true })).toHaveValue('HEAD~1');
  await expect(page.getByRole('textbox', { name: 'Target ref', exact: true })).toHaveValue('HEAD');
  for (const width of [260, 340, 480]) {
    await page.setViewportSize({ width, height: 820 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#reviewBase')).toBeInViewport();
    await expect(page.locator('#send')).toBeInViewport();
  }
  await page.setViewportSize({ width: 260, height: 820 });
  await page.locator('#reviewBase').fill('main');
  await page.locator('#reviewTarget').fill('feature/guard');
  await page.screenshot({ path: testInfo.outputPath('code-review-commit-narrow.png') });
  await page.locator('#prompt').press('Enter');
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'send', text: '', review: { source: 'commits', base: 'main', target: 'feature/guard' } });
});

test('review locks workflow and source controls while running and stops without edit claims', async ({ page }) => {
  await dispatch(page, { type: 'workflow', workflow: 'review' });
  await page.locator('#reviewSource').selectOption('commits');
  await dispatch(page, { type: 'assistantStart', agent: true, review: true });
  for (const id of ['workflow', 'reviewSource', 'reviewBase', 'reviewTarget', 'model']) await expect(page.locator('#' + id)).toBeDisabled();
  await expect(page.locator('#modeHint')).toContainText('Reviewing changes');
  await expect(page.locator('#prompt')).toBeEnabled();
  await dispatch(page, { type: 'status', message: 'Reading the selected diff…' });
  await expect(page.locator('#status')).toHaveText('Reading the selected diff…');
  await expect(page.locator('.assistant, .reasoning, .action')).toHaveCount(0);
  await page.locator('#stop').click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toEqual({ type: 'stop' });
  await dispatch(page, { type: 'assistantDone', outcome: 'cancelled', review: true });
  await expect(page.locator('#status')).toHaveText('Review stopped');
  await expect(page.locator('#status')).not.toContainText('Applied');
  for (const id of ['workflow', 'reviewSource', 'reviewBase', 'reviewTarget']) await expect(page.locator('#' + id)).toBeEnabled();
  await expect(page.locator('#permissionMode')).toBeDisabled();
});

test('dedicated review reports open host references and copy PR summaries with feedback', async ({ page }, testInfo) => {
  await dispatch(page, { type: 'workflow', workflow: 'review' });
  await dispatch(page, { type: 'assistantStart', agent: true, review: true });
  const text = '## Confirmed findings\nHigh: Unsafe default\n\n## Potential risks\nNone reported.\n\nTests were not run.';
  await dispatch(page, { type: 'reviewResult', id: 'report-1', text, report: reviewReport });
  await dispatch(page, { type: 'assistantDone', outcome: 'success', review: true });
  const card = page.locator('.review-report');
  await expect(card).toContainText('Confirmed findings');
  await expect(card).toContainText('Potential risks');
  await expect(card.getByRole('heading', { name: 'High: Unsafe default', exact: true })).toBeVisible();
  await expect(card.locator('pre')).toHaveText('const unsafe = true;');
  await expect(card).toContainText('Tests were not run. This was a read-only review.');
  await page.setViewportSize({ width: 260, height: 980 });
  await page.screenshot({ path: testInfo.outputPath('code-review-report-narrow.png') });
  await expect(page.locator('#status')).toHaveText('Review completed');
  await expect(page.getByRole('button', { name: 'Copy assistant message', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Open src/old.ts:1 (base)', exact: true }).click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toEqual({ type: 'openReviewReference', reportId: 'report-1', findingIndex: 0 });
  const copy = card.getByRole('button', { name: 'Copy review report', exact: true });
  await expect(copy).toHaveClass('icon');
  await expect(copy).toHaveText('');
  await expect(copy).toHaveAttribute('title', 'Copy');
  await expect(copy.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  const copyPath = 'M5 5h8v9H5zM3 11H1V1h8v2';
  await expect(copy.locator('path')).toHaveAttribute('d', copyPath);
  await copy.focus(); await page.keyboard.press('Enter');
  const request = await page.evaluate(() => window.__messages.at(-1));
  expect(request).toEqual({ type: 'copyReview', reportId: 'report-1', requestId: expect.any(String) });
  await expect(copy).toBeDisabled();
  await dispatch(page, { type: 'copyResult', requestId: request!.requestId, success: false });
  await expect(card.locator('.message-actions [role="status"]')).toHaveText('Copy failed. Try again.');
  await expect(copy).toHaveAttribute('title', 'Copy');
  await expect(copy.locator('path')).toHaveAttribute('d', copyPath);
  await copy.click();
  const retry = await page.evaluate(() => window.__messages.at(-1));
  expect(retry!.requestId).not.toBe(request!.requestId);
  await dispatch(page, { type: 'copyResult', requestId: retry!.requestId, success: true });
  await expect(card.locator('.message-actions [role="status"]')).toHaveText('Copied');
  await expect(copy).toBeEnabled();
  await expect(copy).toHaveAttribute('title', 'Copied');
  await expect(copy.locator('path')).toHaveAttribute('d', 'M3 8l3 3 7-7');
  await expect(copy).toHaveText('');
  await expect(card.locator('.message-actions [role="status"]')).toBeEmpty();
  await expect(copy.locator('path')).toHaveAttribute('d', copyPath);
  await expect(copy).toHaveAttribute('title', 'Copy');
});

test('restored review reports retain safe references without executing HTML or creating model links', async ({ page }) => {
  const unsafe = '<img src=x onerror="window.compromised=true"> [execute](command:evil)';
  const report = { ...reviewReport, summary: unsafe, findings: [{ ...reviewReport.findings[0], title: unsafe, evidence: unsafe, path: unsafe }] };
  await dispatch(page, { type: 'workflow', workflow: 'review' });
  await dispatch(page, { type: 'restore', items: [{ id: 'saved-review', role: 'DeepLocal', text: unsafe, reviewReport: report }] });
  const card = page.locator('.review-report');
  await expect(card.locator('.review-summary')).toHaveText(unsafe);
  await expect(card.locator('h3')).toHaveText('High: ' + unsafe);
  await expect(card.locator('pre')).toHaveText(unsafe);
  await expect(card.locator('a, img, script')).toHaveCount(0);
  expect(await page.evaluate(() => 'compromised' in window)).toBe(false);
  await card.locator('.review-references button').click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toEqual({ type: 'openReviewReference', reportId: 'saved-review', findingIndex: 0 });
  await card.getByRole('button', { name: 'Copy review report', exact: true }).click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'copyReview', reportId: 'saved-review' });
});

test('long structured reports show every finding without folding the whole report', async ({ page }) => {
  const report = { ...reviewReport, findings: Array.from({ length: 8 }, (_, index) => ({
    ...reviewReport.findings[0], title: 'Visible finding ' + index, explanation: 'A concrete explanation. '.repeat(40),
    classification: index % 2 ? 'potential' : 'confirmed',
  })) };
  await dispatch(page, { type: 'reviewResult', id: 'long-report', text: 'Formatted export is deliberately ignored.', report });
  const card = page.locator('.review-report');
  await expect(card.locator('.review-finding')).toHaveCount(8);
  await expect(card.locator('details')).toHaveCount(0);
  for (let index = 0; index < 8; index++) await expect(card.getByRole('heading', { name: 'High: Visible finding ' + index, exact: true })).toBeVisible();
  await expect(card).not.toContainText('Formatted export is deliberately ignored.');
  await card.getByRole('button', { name: 'Open src/old.ts:1 (base)', exact: true }).nth(4).click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'openReviewReference', reportId: 'long-report', findingIndex: 1 });
});

test('empty structured report always shows the no-findings caveat and source limitations', async ({ page }) => {
  const report = { ...reviewReport, findings: [], limitations: ['Only tracked changes were reviewed.'] };
  await dispatch(page, { type: 'reviewResult', id: 'empty-report', text: '', report });
  const card = page.locator('.review-report');
  await expect(card).toContainText('This does not establish that the changes are defect-free.');
  await expect(card).toContainText('Tests were not run.');
  await expect(card).toContainText('Only tracked changes were reviewed.');
  await expect(card.getByText('None reported.', { exact: true })).toHaveCount(2);
  await expect(card.locator('.review-references button')).toHaveCount(0);
});

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

for (const [label, command] of [
  ['authorization', "curl -H 'Authorization: Bearer syntheticCredential53'"],
  ['attached filename', 'docker run --env-file=.env.production demo-image'],
]) {
  test(`renders redacted ${label} in live status, row tooltips and history while retaining ordinary targets`, async ({ page }, testInfo) => {
    const sentinel = 'syntheticCredential53';
    const activity = toolActivity('redacted-53', { id: 'call-53', type: 'function', function: {
      name: 'run_command', arguments: JSON.stringify({ command, args: ['payload excluded'] }),
    } });
    await dispatch(page, { type: 'assistantStart', agent: true });
    await dispatch(page, { type: 'status', message: `${activity.title} · ${activity.detail}` });
    await dispatch(page, { type: 'toolStart', activity });
    await expect(page.locator('#status')).toHaveText('Run command · [sensitive target redacted]');
    await expect(page.locator('.action-path')).toHaveText('[sensitive target redacted]');
    await expect(page.locator('.action-path')).toHaveAttribute('title', '[sensitive target redacted]');
    await dispatch(page, { type: 'toolResult', text: 'run_command\nUser declined command execution.', activity: { ...activity, state: 'declined' } });
    await expect(page.locator('.action-state')).toHaveText('Declined');
    const ordinary = toolActivity('ordinary-53', { id: 'call-ordinary', type: 'function', function: {
      name: 'search_workspace', arguments: '{"query":"basic usage"}',
    } });
    await dispatch(page, { type: 'toolStart', activity: ordinary });
    await expect(page.locator('.action-path')).toHaveText(['[sensitive target redacted]', 'basic usage']);
    expect(await page.locator('body').innerHTML()).not.toContain(sentinel);
    expect(await page.locator('body').innerHTML()).not.toContain(command);
    expect(await page.locator('body').innerHTML()).not.toContain('payload excluded');
    await page.screenshot({ path: testInfo.outputPath('redacted-tool-activity.png') });
    await dispatch(page, { type: 'restore', items: [{ role: 'Tool', text: 'run_command\nUser declined command execution.', activity: { ...activity, state: 'declined' } }] });
    await expect(page.locator('.action-path')).toHaveText('[sensitive target redacted]');
    await expect(page.locator('.action-path')).toHaveAttribute('title', '[sensitive target redacted]');
    expect(await page.locator('body').innerHTML()).not.toContain(sentinel);
    expect(await page.locator('body').innerHTML()).not.toContain(command);
  });
}

for (const theme of ['dark', 'light']) {
  test(`session previews retain safe full labels, Unicode and keyboard switching in ${theme} narrow sidebars`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme as 'dark' | 'light' });
    if (theme === 'light') await page.addStyleTag({ content: ':root { --vscode-foreground:#222; --vscode-sideBar-background:#f5f5f5; --vscode-descriptionForeground:#555; --vscode-editorWidget-background:#fff; --vscode-dropdown-background:#fff; --vscode-input-background:#fff; --vscode-input-foreground:#222; --vscode-widget-border:#ccc; }' });
    const preview = '  Inspect\n日本語 👩🏽‍💻 é <img src=x onerror="window.synthetic57=true"> & </option><script>window.synthetic57=true</script> ' + 'more context '.repeat(25);
    const normalized = preview.replace(/\s+/g, ' ').trim();
    const sessions = [
      { id: 'one', title: 'Saved task', preview },
      { id: 'two', title: 'Saved task', preview: 'Different latest request' },
      { id: 'empty', title: 'New session', preview: ' \n\t ' },
      { id: 'legacy', title: 'Previous session' },
      { id: 'unicode', title: 'Unicode task', preview: 'a'.repeat(59) + '👩🏽‍💻é' },
      { id: 'boundary', title: 'Boundary task', preview: 'a'.repeat(60) },
    ];
    await dispatch(page, { type: 'sessions', activeSessionId: 'one', sessions });
    await page.getByRole('button', { name: 'Task history', exact: true }).click();
    const selector = page.locator('#session');
    await expect(selector).toHaveAccessibleName('Recent tasks in this workspace');
    const option = selector.locator('option').first();
    await expect(option).toHaveText('Saved task — Inspect 日本語 👩🏽‍💻 é <img src=x onerror="window.synthetic57=true"…');
    await expect(option).toHaveAttribute('title', 'Saved task — ' + normalized);
    await expect(option).toHaveAccessibleName('Saved task — ' + normalized);
    await expect(selector).toHaveAttribute('title', 'Saved task — ' + normalized);
    await expect(selector.locator('option').nth(2)).toHaveText('New session');
    await expect(selector.locator('option').nth(3)).toHaveText('Previous session');
    await expect(selector.locator('option').nth(4)).toHaveText('Unicode task — ' + 'a'.repeat(59) + '👩🏽‍💻…');
    await expect(selector.locator('option').nth(5)).toHaveText('Boundary task — ' + 'a'.repeat(60));
    expect(await selector.locator('img,script').count()).toBe(0);
    expect(await page.evaluate(() => 'synthetic57' in window)).toBe(false);
    await page.locator('#prompt').fill('Draft for first task');
    await page.getByRole('button', { name: 'Close task history', exact: true }).click();
    for (const width of [260, 340, 480]) {
      await page.setViewportSize({ width, height: 820 });
      await page.getByRole('button', { name: 'Task history', exact: true }).click();
      await expect(selector).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const bounds = await selector.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`session-preview-${theme}-${width}.png`) });
      await page.getByRole('button', { name: 'Close task history', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Task history', exact: true }).click();
    await selector.focus();
    await selector.press('ArrowDown');
    await expect(selector).toHaveValue('two');
    expect(await page.evaluate(() => window.__messages.at(-1))).toEqual({ type: 'switchSession', sessionId: 'two' });
    await expect(page.locator('#historyPanel')).toBeHidden();
    await dispatch(page, { type: 'sessions', activeSessionId: 'two', sessions });
    await expect(selector).toHaveAttribute('title', 'Saved task — Different latest request');
    await expect(page.locator('#taskTitle')).toHaveText('Saved task');
    await expect(page.locator('#prompt')).toHaveValue('');
    await page.locator('#prompt').fill('Draft for second task');
    await dispatch(page, { type: 'sessions', activeSessionId: 'one', sessions });
    await dispatch(page, { type: 'restore', items: [{ role: 'You', text: preview }] });
    await expect(page.locator('#prompt')).toHaveValue('Draft for first task');
    await expect(selector).toHaveValue('one');
    await dispatch(page, { type: 'sessions', activeSessionId: 'one', sessions: [{ ...sessions[0], preview: 'Updated latest request' }, ...sessions.slice(1)] });
    await expect(option).toHaveText('Saved task — Updated latest request');
    await expect(selector).toHaveAttribute('title', 'Saved task — Updated latest request');
    await dispatch(page, { type: 'assistantStart' });
    await expect(selector).toBeDisabled();
    await expect(page.locator('#historyButton')).toBeDisabled();
    await dispatch(page, { type: 'assistantDone', outcome: 'success' });
    await expect(selector).toBeEnabled();
  });
}

for (const scenario of [
  { name: 'failed English claim', code: "console.error('compile failed');process.exitCode=2", text: 'All fixed. The build passed and no errors remain.', state: 'failed' },
  { name: 'zero-action German claim', code: undefined, text: 'Alles behoben. Build und Tests sind erfolgreich.', state: 'unverified' },
]) {
  test(`contradictory suggestions keep an unverified label in live/copy/restore: ${scenario.name}`, async ({ page }, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'completion82-unverified-'));
    try {
      const evidence = new TaskEvidence(), args = scenario.code ? ['-e', scenario.code] : ['run', 'build'];
      const executable = scenario.code ? 'node' : 'npm';
      if (scenario.code) {
        const command = await executeCommand(executable, args, directory);
        evidence.record({ id: 'failed82', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: executable, args }) } },
          { callId: 'failed82', name: 'run_command', status: 'error', content: 'Compilation failed', command });
      }
      const report = evidence.report(JSON.stringify({ checks: [{ command: executable, args, reason: scenario.text }], nextSteps: scenario.text }));
      const text = formatCompletion(report);
      await page.setViewportSize({ width: 260, height: 820 });
      await dispatch(page, { type: 'restore', items: [] });
      await dispatch(page, { type: 'assistantStart', agent: true });
      await dispatch(page, { type: 'assistantFinal', text, completionReport: report });
      await dispatch(page, { type: 'assistantDone', outcome: 'success' });
      await expect(page.locator('.completion-status')).toHaveText('Verification: ' + scenario.state);
      await expect(page.locator('.completion-report > .prose')).toHaveCount(0);
      const notes = page.locator('.model-suggestions');
      await expect(notes.locator('summary')).toHaveText('Unverified model suggestions — not completion evidence');
      await expect(notes.locator('.prose')).not.toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`unverified-${scenario.state}-collapsed.png`) });
      await notes.locator('summary').focus(); await page.keyboard.press('Enter');
      await expect(notes.locator('.prose')).toHaveText(scenario.text);
      await expect(notes.locator('.prose')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`unverified-${scenario.state}-expanded.png`) });
      await page.getByRole('button', { name: 'Copy assistant message' }).click();
      const copied = await page.evaluate(() => window.__messages.at(-1));
      expect(copied).toMatchObject({ type: 'copy', text });
      const copiedReport = JSON.parse(copied!.text as string);
      expect(copiedReport).not.toHaveProperty('nextSteps');
      expect(copiedReport.unverifiedModelText).toMatchObject({ source: 'model', verified: false,
        notice: 'Suggestions and stated reasons are not completion evidence.', nextSteps: scenario.text });
      await dispatch(page, { type: 'restore', items: [{ role: 'DeepLocal', text, completionReport: report }] });
      await expect(notes.locator('.prose')).not.toBeVisible();
      await expect(notes.locator('summary')).toContainText('Unverified model suggestions');
      await notes.locator('summary').press('Enter');
      await expect(notes.locator('.prose')).toHaveText(scenario.text);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

for (const limitation of [
  'Verification stopped after two identical failures. Inspect the recorded diagnostics before continuing.',
  'Repair iteration limit reached (3). Verification remains incomplete; review the failed check.',
]) {
  test(`host repair stop remains failed and unchanged through copy/restore: ${limitation}`, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'repair79-browser-'));
    try {
      const args = ['-e', "console.error('fixture.ts:1:1 lint error remains');process.exitCode=1"];
      const command = await executeCommand('node', args, directory);
      const evidence = new TaskEvidence();
      evidence.record({ id: 'lint79', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node', args, verification: true }) } },
        { callId: 'lint79', name: 'run_command', status: 'error', content: 'lint failed', command });
      const report = { ...evidence.report(JSON.stringify({ checks: [], nextSteps: 'All fixed and verified.' })), limitation };
      const text = formatCompletion(report);
      await page.setViewportSize({ width: 260, height: 820 });
      await dispatch(page, { type: 'assistantStart', agent: true });
      await dispatch(page, { type: 'assistantFinal', text, completionReport: report });
      await dispatch(page, { type: 'assistantDone', outcome: 'success' });
      for (const restored of [false, true]) {
        if (restored) await dispatch(page, { type: 'restore', items: [{ role: 'DeepLocal', text, completionReport: report }] });
        await expect(page.locator('.completion-status')).toHaveText('Verification: failed');
        await expect(page.getByRole('list', { name: 'Declared checks' })).toContainText('failed');
        await expect(page.locator('.completion-report')).toContainText(limitation);
        await expect(page.locator('.model-suggestions .prose')).not.toBeVisible();
        await page.locator('.completion-report > details:not(.model-suggestions) > summary').press('Enter');
        await expect(page.locator('.completion-report pre')).toContainText('fixture.ts:1:1 lint error remains');
        await page.getByRole('button', { name: 'Copy assistant message' }).click();
        const copied = await page.evaluate(() => window.__messages.at(-1));
        expect(copied).toMatchObject({ type: 'copy', text });
        expect(JSON.parse(copied!.text as string)).toEqual(report);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('empty, interrupted and blocked completion reports preserve their limits', async ({ page }) => {
  const evidence = new TaskEvidence();
  const reports = [evidence.report(), evidence.report(undefined, 'Task stopped; no tools ran.'),
    evidence.report(JSON.stringify({ checks: [{ command: 'npm', args: ['run', 'build'], notRun: 'blocked', reason: 'Approval unavailable' }], nextSteps: '' }))];
  for (const report of reports) {
    await dispatch(page, { type: 'restore', items: [{ role: 'DeepLocal', text: formatCompletion(report), completionReport: report }] });
    await expect(page.locator('.completion-status')).toHaveText('Verification: ' + report.verification);
    await expect(page.locator('.completion-report')).toContainText('task completeness is not established');
    await expect(page.locator('.completion-report .prose')).toHaveCount(0);
    await page.locator('.completion-report > details:not(.model-suggestions) > summary').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.completion-report pre')).toContainText('"attempts": []');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

for (const theme of ['dark', 'light'] as const) {
  test(`completion facts remain visible, copyable and safe in ${theme} live/restored reports`, async ({ page }, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'completion82-browser-'));
    try {
      await writeFile(join(directory, 'fixture.txt'), 'src/main.ts:8 lint failure\nAPI_KEY=syntheticCredential82\n<img src=x onerror="window.synthetic82=true">');
      const args = ['-e', "process.stdout.write(require('fs').readFileSync('fixture.txt'));process.exitCode=1"];
      const command = await executeCommand('node', args, directory);
      const evidence = new TaskEvidence();
      evidence.record({ id: 'lint82', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node', args }) } },
        { callId: 'lint82', name: 'run_command', status: 'error', content: JSON.stringify({ ...command, cwd: '/synthetic-workspace' }), command });
      const report = evidence.report(JSON.stringify({ checks: [{ command: 'node', args }, { command: 'npm', args: ['run', 'build'] }], nextSteps: 'Bitte zuerst den Fehler beheben. <img src=x onerror="window.synthetic82=true">' }));
      const text = formatCompletion(report);
      if (theme === 'light') await page.addStyleTag({ content: ':root { --vscode-foreground:#222; --vscode-sideBar-background:#f5f5f5; --vscode-descriptionForeground:#555; --vscode-textCodeBlock-background:#eee; --vscode-input-background:#fff; --vscode-input-foreground:#222; --vscode-dropdown-background:#fff; --vscode-input-border:#ccc; --vscode-panel-border:#ddd; --vscode-focusBorder:#005fb8; }' });
      for (const width of [260, 340, 480]) {
        await page.setViewportSize({ width, height: 820 });
        await dispatch(page, { type: 'restore', items: [] });
        await dispatch(page, { type: 'assistantStart', agent: true });
        await dispatch(page, { type: 'assistantFinal', text, completionReport: report });
        await dispatch(page, { type: 'assistantDone', outcome: 'success' });
        await expect(page.locator('.completion-status')).toHaveText('Verification: failed');
        await expect(page.getByRole('list', { name: 'Declared checks' })).toContainText('not_run');
        await expect(page.locator('#status')).toHaveText('Verification: failed');
        await expect(page.locator('.completion-report')).toContainText('task completeness is not established');
        await expect(page.locator('.completion-report')).toContainText('Bitte zuerst den Fehler beheben.');
        const summary = page.locator('.completion-report > details:not(.model-suggestions) > summary');
        await summary.focus(); await summary.press('Enter');
        await expect(page.locator('.completion-report pre')).toBeVisible();
        await expect(page.locator('.completion-report pre')).toContainText('src/main.ts:8 lint failure');
        expect(await page.locator('.completion-report').textContent()).not.toContain('syntheticCredential82');
        await expect(page.locator('.completion-report img, .completion-report script')).toHaveCount(0);
        expect(await page.evaluate(() => 'synthetic82' in window)).toBe(false);
        const contrast = await page.locator('.completion-status').evaluate(node => {
          const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
          const foreground = rgb(getComputedStyle(node).color), background = rgb(getComputedStyle(document.body).backgroundColor);
          return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
        });
        expect(contrast).toBeGreaterThanOrEqual(4.5);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`completion-${theme}-${width}.png`) });
        const notes = page.locator('.model-suggestions');
        await expect(notes).not.toHaveAttribute('open', '');
        await expect(notes.locator('summary')).toHaveText('Unverified model suggestions — not completion evidence');
        await expect(notes.locator('.prose')).not.toBeVisible();
        await notes.locator('summary').focus(); await page.keyboard.press('Enter');
        await expect(notes.locator('.prose')).toBeVisible();
        const copy = page.getByRole('button', { name: 'Copy assistant message' });
        await copy.focus(); await copy.press('Enter');
        expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'copy', text });
        await dispatch(page, { type: 'restore', items: [{ role: 'DeepLocal', text, completionReport: report }] });
        await expect(page.locator('.completion-status')).toHaveText('Verification: failed');
        await expect(page.getByRole('button', { name: 'Copy assistant message' })).toHaveCount(1);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`failed command diagnostics are readable, bounded and safe in live/restored ${theme} activity`, async ({ page }, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-command-'));
    try {
      await writeFile(join(directory, 'diagnostics.txt'), 'src/main.ts:8:1 error no-unused-vars\nAPI_KEY=syntheticCredential78\n<img src=x onerror="window.synthetic78=true">\n' + 'context line\n'.repeat(2000) + 'final diagnostic tail\n');
      const result = await executeCommand('node', ['-e', "const fs=require('fs');process.stdout.write(fs.readFileSync('diagnostics.txt'));process.stderr.write('stderr diagnostic\\n');process.exitCode=1"], directory);
      expect(result).toMatchObject({ exitCode: 1, truncated: true, stderr: 'stderr diagnostic\n' });
      // Public screenshots use a labelled synthetic workspace instead of the host temp path.
      const visibleResult = { ...result, cwd: '/synthetic-workspace' };
      const text = 'run_command\n' + JSON.stringify(visibleResult, null, 2);
      const activity = { id: 'command-result-78', title: 'Run command', detail: 'node', state: 'error' };
      await page.emulateMedia({ colorScheme: theme });
      if (theme === 'light') await page.addStyleTag({ content: ':root { --vscode-foreground:#222; --vscode-sideBar-background:#f5f5f5; --vscode-descriptionForeground:#555; --vscode-editor-background:#fff; --vscode-panel-border:#ddd; --vscode-input-background:#fff; --vscode-input-foreground:#222; --vscode-dropdown-background:#fff; --vscode-input-border:#ccc; --vscode-textCodeBlock-background:#eee; --vscode-badge-background:#eee; --vscode-badge-foreground:#222; --vscode-errorForeground:#a1260d; }' });
      for (const width of [260, 340, 480]) {
        await page.setViewportSize({ width, height: 820 });
        await dispatch(page, { type: 'restore', items: [] });
        await dispatch(page, { type: 'toolStart', activity: { ...activity, state: 'running' } });
        await dispatch(page, { type: 'toolResult', text, activity });
        await expect(page.locator('.action-state')).toHaveText('Failed');
        const summary = page.locator('.action summary');
        await summary.focus(); await summary.press('Enter');
        const output = page.locator('.action pre');
        await expect(output).toContainText('src/main.ts:8:1 error no-unused-vars');
        await expect(output).toContainText('stderr diagnostic');
        await expect(output).toContainText('final diagnostic tail');
        await expect(output).toContainText('truncated');
        expect(await output.textContent()).not.toContain('syntheticCredential78');
        expect(await page.evaluate(() => 'synthetic78' in window)).toBe(false);
        await expect(page.locator('.action img, .action script')).toHaveCount(0);
        for (const element of [output, page.locator('.action-state')]) {
          const contrast = await element.evaluate(node => {
            const style = getComputedStyle(node);
            const luminance = (color: string) => {
              const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
                const channel = Number(value) / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              });
              return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
            };
            const foreground = luminance(style.color), background = luminance(style.backgroundColor);
            return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
          });
          expect(contrast).toBeGreaterThanOrEqual(4.5);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`command-result-${theme}-${width}.png`) });
        await output.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.screenshot({ path: testInfo.outputPath(`command-result-tail-${theme}-${width}.png`) });
        await dispatch(page, { type: 'restore', items: [{ role: 'Tool', text, activity }] });
        await page.locator('.action summary').click();
        await expect(page.locator('.action pre')).toHaveText(text.slice('run_command\n'.length));
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
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
  await expect(page.locator('.assistant .prose')).toHaveText('The configuration is ready.');
  await expect(page.locator('.reasoning')).not.toContainText('The configuration is ready.');
});

test('copies complete rendered replies with folded code, keyboard access and feedback', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 260, height: 820 });
  const copy = page.getByRole('button', { name: 'Copy assistant message', exact: true });
  await dispatch(page, { type: 'assistantStart' });
  await expect(copy).toHaveCount(0);
  const text = 'Run this:\n```ts\nconsole.log("<safe>");\n```\nThen continue.\n' + 'Long answer. '.repeat(150);
  await dispatch(page, { type: 'assistantDelta', text });
  await expect(page.locator('.code')).toHaveCount(2);
  await expect(copy).toHaveCount(0);
  await dispatch(page, { type: 'assistantFinal', text });
  await expect(copy).toHaveCount(0);
  await dispatch(page, { type: 'assistantDone', outcome: 'success' });
  await expect(copy).toBeVisible();
  await expect(copy).toHaveAttribute('title', 'Copy');
  await expect(copy).toHaveText('');
  await expect(copy.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  const copyPath = await copy.locator('path').getAttribute('d');
  await page.getByRole('button', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(copy).toBeFocused();
  await page.keyboard.press('Enter');
  const request = await page.evaluate(() => window.__messages.at(-1));
  expect(request).toMatchObject({ type: 'copy', text: text.replace('```ts\n', '').replace('```', '') });
  await expect(copy).toBeDisabled();
  await expect(page.locator('.message-actions [role="status"]')).toBeEmpty();
  await dispatch(page, { type: 'copyResult', requestId: request!.requestId, success: true });
  await expect(copy).toBeEnabled();
  await expect(page.locator('.message-actions [role="status"]')).toHaveText('Copied');
  await expect(copy).toHaveAttribute('title', 'Copied');
  await expect(copy.locator('path')).toHaveAttribute('d', 'M3 8l3 3 7-7');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('copy-completed-narrow.png') });
  await expect(page.locator('.message-actions [role="status"]')).toBeEmpty();
  await expect(copy.locator('path')).toHaveAttribute('d', copyPath!);
  await expect(copy).toHaveAttribute('title', 'Copy');
  // Earlier replies remain copyable while the next reply is streaming.
  await dispatch(page, { type: 'assistantStart' });
  await copy.press('Space');
  const retry = await page.evaluate(() => window.__messages.at(-1));
  await dispatch(page, { type: 'copyResult', requestId: retry!.requestId, success: false });
  await expect(page.locator('.message-actions [role="status"]')).toHaveText('Copy failed. Try again.');
  await expect(copy.locator('path')).toHaveAttribute('d', copyPath!);
  await expect(copy).toBeEnabled();
});

test('only completed answers get Copy controls and restored answers retain them', async ({ page }) => {
  const copy = page.getByRole('button', { name: 'Copy assistant message', exact: true });
  for (const outcome of ['cancelled', 'error', 'success']) {
    await dispatch(page, { type: 'assistantStart' });
    if (outcome !== 'success') await dispatch(page, { type: 'assistantDelta', text: 'Partial answer' });
    await dispatch(page, { type: 'assistantDone', outcome });
    await expect(copy).toHaveCount(0);
  }
  await dispatch(page, { type: 'restore', items: [
    { role: 'You', text: 'Question' }, { role: 'Reasoning', text: 'Thinking' },
    { role: 'DeepLocal', text: 'Saved answer' }, { role: 'DeepLocal', text: '' },
  ] });
  await expect(copy).toHaveCount(1);
  await copy.click();
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'copy', text: 'Saved answer' });
});

test('preserves model selection, exposes agent modes, and does not submit IME composition', async ({ page }) => {
  await page.locator('#model').selectOption('local-model');
  await dispatch(page, { type: 'models', models: ['gpt-6-luna', 'local-model'], backend: 'remote', hasApiKey: true });
  await expect(page.locator('#model')).toHaveValue('local-model');
  await expect(page.locator('#agentMode')).toHaveCount(0);
  await expect(page.locator('#chatMode')).toHaveCount(0);
  await expect(page.locator('#permissionMode option')).toHaveText(['Approve every action', 'Safe auto', 'Full access', 'Ask only']);
  await page.locator('#permissionMode').selectOption('ask');
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'setApprovalMode', approvalMode: 'ask' });
  await page.locator('#prompt').fill('Hello');
  await page.locator('#prompt').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  expect(await page.evaluate(() => window.__messages.some(message => message.type === 'send'))).toBe(false);
  await page.locator('#prompt').press('Enter');
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'send', useAgent: false, model: 'local-model', text: 'Hello' });
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

test('streams provider summaries independently from commentary and the final answer', async ({ page }, testInfo) => {
  await dispatch(page, { type: 'assistantStart', agent: true });
  await dispatch(page, { type: 'reasoningStart' });
  await dispatch(page, { type: 'summaryDelta', id: 'summary1', text: 'First, I will inspect the configuration.' });
  await expect(page.locator('.summary-block')).toHaveAttribute('open');
  await expect(page.locator('.summary-block summary')).toHaveText('Reasoning summary');
  await dispatch(page, { type: 'reasoningDelta', text: 'I will read the configuration file.' });
  await dispatch(page, { type: 'toolStart', activity: { id: 'read1', title: 'Read file', detail: 'src/Working.ts', state: 'running' } });
  await expect(page.locator('.summary-block')).not.toHaveAttribute('open');
  await expect(page.locator('.action-title')).toHaveText('Read file');
  await expect(page.locator('.action-path')).toHaveText('src/Working.ts');
  await dispatch(page, { type: 'toolResult', text: 'read_file\nWorking', activity: { id: 'read1', title: 'Read file', detail: 'src/Working.ts', state: 'success' } });
  await expect(page.locator('.action pre')).toHaveText('Working');
  await page.locator('.summary-block summary').click();
  await dispatch(page, { type: 'reasoningStart' });
  await dispatch(page, { type: 'summaryDelta', id: 'summary2', text: 'The configuration is healthy.' });
  await dispatch(page, { type: 'reasoningDelta', text: 'The check is complete.' });
  await dispatch(page, { type: 'assistantFinal', text: 'The check is complete.' });
  await dispatch(page, { type: 'assistantDone', outcome: 'success' });
  await expect(page.locator('.summary-block')).toHaveCount(2);
  await expect(page.locator('.summary-block').first()).toHaveAttribute('open');
  await expect(page.locator('.summary-block').last()).not.toHaveAttribute('open');
  await expect(page.locator('.assistant .prose')).toHaveText('The check is complete.');
  await expect(page.locator('#status')).toHaveText('Task completed');
  await page.screenshot({ path: testInfo.outputPath('summaries-chinese.png') });
  await dispatch(page, { type: 'restore', items: [{ role: 'Summary', id: 'old', text: '<script>unsafe()</script>' }, { role: 'DeepLocal', text: 'Done' }] });
  await expect(page.locator('.summary-block')).not.toHaveAttribute('open');
  await expect(page.locator('.summary-block .prose')).toHaveText('<script>unsafe()</script>');
  await expect(page.locator('#messages script')).toHaveCount(0);
  await expect(page.locator('.assistant .prose')).toHaveText('Done');
});

test('keeps controls accessible while switching API protocol and summary settings', async ({ page }) => {
  await expect(page.locator('#prompt')).toHaveAttribute('placeholder', 'Ask the agent to build, fix, or explore…');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#settingsButton')).toHaveAttribute('aria-label', 'Settings');
  await expect(page.locator('#prompt')).toHaveAttribute('placeholder', 'Ask the agent to build, fix, or explore…');
  await page.locator('#apiMode').selectOption('responses');
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'setApiMode', apiMode: 'responses' });
  await dispatch(page, { type: 'models', models: ['local-model'], backend: 'local', apiMode: 'responses', reasoningSummary: 'auto' });
  await expect(page.locator('#reasoningSummary')).toBeEnabled();
  await page.locator('#reasoningSummary').selectOption('off');
  expect(await page.evaluate(() => window.__messages.at(-1))).toMatchObject({ type: 'setSummary', summary: 'off' });
  await dispatch(page, { type: 'status', message: 'Working · step 2' });
  await expect(page.locator('#status')).toHaveText('Working · step 2');
  await dispatch(page, { type: 'approval', approvalId: 'a', message: 'Create src/Ready.ts (12 lines)', hasPreview: true });
  await expect(page.locator('#reviewTitle')).toHaveText('Create src/Ready.ts (12 lines)');
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

test('clears submitted text, keeps a follow-up draft, and rejects deletion explicitly', async ({ page }) => {
  await page.locator('#prompt').fill('Delete obsolete.html');
  await page.locator('#send').click();
  await expect(page.locator('#prompt')).toHaveValue('');
  await expect(page.locator('.message.user')).toContainText('Delete obsolete.html');
  await dispatch(page, { type: 'assistantStart' });
  await expect(page.locator('#modeHint')).toContainText('Draft a follow-up');
  await page.locator('#prompt').fill('Use the safer alternative instead.');
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
  await expect(page.locator('#prompt')).toHaveValue('Use the safer alternative instead.');
  await expect(page.locator('#status')).toHaveText('Needs attention');
  await expect(page.locator('#send')).toBeEnabled();
});

test('workspace selector is keyboard accessible, safely labels the target and stays locked during work', async ({ page }, testInfo) => {
  await dispatch(page, { type: 'workspace', label: 'Choose workspace folder', canSelect: true });
  const selector = page.getByRole('button', { name: 'Choose workspace folder', exact: true });
  await selector.focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__messages.at(-1))).toEqual({ type: 'selectWorkspace' });
  await dispatch(page, { type: 'workspace', label: 'api (/tmp/second/api)', path: 'file:///tmp/second/api', canSelect: true });
  await expect(selector).toHaveText('Workspace: api (/tmp/second/api)');
  await expect(selector).toHaveAttribute('title', 'file:///tmp/second/api');
  await dispatch(page, { type: 'assistantStart', agent: true });
  await expect(selector).toBeDisabled();
  await dispatch(page, { type: 'toolStart', activity: { id: 'one', title: 'Read file', detail: 'same.txt', state: 'running' } });
  await expect(selector).toContainText('api (/tmp/second/api)');
  await expect(selector).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('selected-workspace-running.png') });
  await dispatch(page, { type: 'assistantDone', outcome: 'cancelled' });
  await expect(selector).toBeEnabled();
  await selector.focus();
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => window.__messages.at(-1))).toEqual({ type: 'selectWorkspace' });
  await dispatch(page, { type: 'workspace', label: '<script>example</script> 日本語', path: 'file:///tmp/one', canSelect: false });
  await expect(selector).toHaveText('Workspace: <script>example</script> 日本語');
  await expect(selector.locator('script')).toHaveCount(0);
  await expect(selector).toBeDisabled();
  await dispatch(page, { type: 'workspace', label: 'No folder open', canSelect: false });
  await expect(selector).toHaveText('Workspace: No folder open');
});
