import * as vscode from 'vscode';
import { AgentToolResult, getAgentTools, invokeAgentTool, toolResultsToMessages, verifyResearchSources } from './agent-tools';
import { getConfig } from './config';
import { DeepLocalClient } from './deeplocal-client';
import { Logger } from './logger';
import { ChatMessage, ToolCall, ResponseContext, StreamEvent } from './protocol';
import { renderChatHtml } from './chat-webview';
import { toolActivity, ToolActivity, redactToolActivityDetail } from './tool-activity';
import { requireWorkspaceFolder, sameWorkspace, workspaceLabel } from './agent-workspace';
import { createGitReview } from './review-git';
import { runReview } from './review-runner';
import { formatReviewReport } from './review-report';
import { ReviewRequest, ReviewReport } from './review-types';
import { completionTool, CompletionReport, formatCompletion, TaskEvidence } from './task-evidence';
import { AgentRepair } from './agent-repair';
import { delegationTool, SubagentManager } from './subagent-manager';
import { ResearchLimitError } from './subagent-runner';
import { DEFAULT_SUBAGENT_LIMITS, SubagentActivity, SubagentTask } from './subagent-types';

interface WebviewMessage {
  type: 'selectWorkspace' | 'ready' | 'send' | 'stop' | 'approval' | 'preview' | 'refreshModels' | 'newSession' | 'switchSession' | 'deleteSession' | 'setBackend' | 'setRemoteApiKey' | 'clearRemoteApiKey' | 'setApiMode' | 'setSummary' | 'setApprovalMode' | 'copy' | 'setWorkflow' | 'openReviewReference' | 'copyReview';
  requestId?: string;
  apiMode?: 'chat-completions' | 'responses';
  summary?: 'off' | 'auto';
  approvalMode?: 'every' | 'safe' | 'full' | 'ask';
  approvalId?: string;
  approved?: boolean;
  text?: string;
  model?: string;
  sessionId?: string;
  useAgent?: boolean;
  workflow?: 'normal' | 'review';
  review?: ReviewRequest;
  reportId?: string;
  findingIndex?: number;
}

interface PersistedChatItem {
  role: 'You' | 'DeepLocal' | 'Tool' | 'Reasoning' | 'Summary';
  id?: string;
  text: string;
  activity?: ToolActivity;
  reviewReport?: ReviewReport;
  completionReport?: CompletionReport;
  subagent?: SubagentActivity;
}

interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  history: ChatMessage[];
  transcript: PersistedChatItem[];
  workflow?: 'normal' | 'review';
}

export class ChatPanel implements vscode.WebviewViewProvider {
  private static readonly historyKey = 'deeplocal.chat.history';
  private static readonly transcriptKey = 'deeplocal.chat.transcript';
  private static readonly sessionsKey = 'deeplocal.sessions';
  private static readonly activeSessionKey = 'deeplocal.activeSessionId';
  private static readonly migrationKey = 'deeplocal.sessions.migrated.v1';

  private selectedWorkspace: vscode.WorkspaceFolder | undefined;
  private taskWorkspace: vscode.WorkspaceFolder | undefined;
  private choosingWorkspace = false;
  private choosingWorkflow = false;
  private sessions: ChatSession[] = [];
  private activeSessionId: string;
  private activeRequestId: string | undefined;
  private taskController: AbortController | undefined;
  private pendingApproval: { id: string; resolve: (approved: boolean) => void; preview?: () => Promise<void> } | undefined;
  private readonly approvalQueue: Array<{ start: () => void; cancel: () => void }> = [];
  private subagents: SubagentManager | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private view: vscode.WebviewView | undefined;
  private readonly reviewDocuments = new Map<string, string>();
  private readonly scopedSessionsKey = `${ChatPanel.sessionsKey}.${workspaceIdentity()}`;
  private readonly scopedActiveSessionKey = `${ChatPanel.activeSessionKey}.${workspaceIdentity()}`;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: DeepLocalClient,
    private readonly logger: Logger,
    private readonly remoteApiKey: {
      get: () => PromiseLike<string | undefined>;
      set: (key: string) => Promise<void>;
      clear: () => Promise<void>;
    },
  ) {
    this.context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
      if (this.taskWorkspace && event.removed.some(folder => sameWorkspace(folder, this.taskWorkspace!))) {
        this.post({ type: 'notice', message: 'The task workspace folder was removed. Stopping the task; select a folder before continuing.' });
        this.stopTask();
      }
      if (this.selectedWorkspace && event.removed.some(folder => sameWorkspace(folder, this.selectedWorkspace!))) {
        this.selectedWorkspace = undefined;
      }
      this.postWorkspace();
    }));
    this.context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('deeplocal-review', {
      provideTextDocumentContent: uri => this.reviewDocuments.get(uri.toString()) ?? '',
    }));
    this.context.subscriptions.push({ dispose: () => this.reviewDocuments.clear() });
    this.sessions = this.loadSessions().map(interruptResearch).map(repairTranscript);
    this.activeSessionId = this.context.workspaceState.get<string>(this.scopedActiveSessionKey, this.sessions[0].id);
    if (!this.sessions.some((session) => session.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0].id;
    }
  }

  private currentWorkspace(): vscode.WorkspaceFolder | undefined {
    try { return requireWorkspaceFolder(this.selectedWorkspace); } catch { return undefined; }
  }

  private postWorkspace(): void {
    const folder = this.taskWorkspace ?? this.currentWorkspace();
    this.post({
      type: 'workspace',
      label: folder ? workspaceLabel(folder) : vscode.workspace.workspaceFolders?.length ? 'Choose workspace folder' : 'No folder open',
      path: folder?.uri.toString(),
      canSelect: !this.activeRequestId && !this.choosingWorkspace && (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
    });
  }

  private async selectWorkspace(): Promise<void> {
    if (this.activeRequestId || this.choosingWorkspace) return;
    this.choosingWorkspace = true;
    this.postWorkspace();
    try {
      const selected = await vscode.window.showQuickPick((vscode.workspace.workspaceFolders ?? []).map(folder => ({
        label: folder.name, description: folder.uri.toString(), folder,
      })), { placeHolder: 'Choose the folder for agent operations', title: 'Agent workspace folder' });
      if (selected) this.selectedWorkspace = requireWorkspaceFolder(selected.folder);
    } finally {
      this.choosingWorkspace = false;
      this.postWorkspace();
    }
  }

  async newSession(): Promise<void> {
    if (this.activeRequestId) return;

    const workflow = this.activeSession().workflow;
    const session = createSession();
    session.workflow = workflow;
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    await this.persist();
    this.postSessions();
    this.restoreTranscript();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
    };
    view.webview.html = renderChatHtml(view.webview);
    view.onDidDispose(() => {
      this.stopTask();
      this.view = undefined;
    });

    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message).catch((error) => this.postError(messageOf(error)));
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === 'copy' && typeof message.text === 'string' && typeof message.requestId === 'string') {
      try {
        await vscode.env.clipboard.writeText(message.text);
        this.post({ type: 'copyResult', requestId: message.requestId, success: true });
      } catch {
        this.post({ type: 'copyResult', requestId: message.requestId, success: false });
      }
      return;
    }
    if (message.type === 'stop') { this.stopTask(); return; }
    if (message.type === 'openReviewReference') {
      await this.openReviewReference(message.reportId, message.findingIndex);
      return;
    }
    if (message.type === 'copyReview') {
      const report = this.activeSession().transcript.find(item => item.id === message.reportId)?.reviewReport;
      if (!report || typeof message.requestId !== 'string') return;
      try {
        await vscode.env.clipboard.writeText(formatReviewReport(report));
        this.post({ type: 'copyResult', requestId: message.requestId, success: true });
      } catch {
        this.post({ type: 'copyResult', requestId: message.requestId, success: false });
      }
      return;
    }
    if (message.type === 'approval' || message.type === 'preview') {
      const pending = this.pendingApproval;
      if (!pending || pending.id !== message.approvalId) return;
      if (message.type === 'preview') {
        try { await pending.preview?.(); } catch (error) { this.postError(messageOf(error)); }
      } else pending.resolve(message.approved === true);
      return;
    }
    if (message.type === 'ready') this.postWorkspace();
    if (this.activeRequestId || this.choosingWorkflow) return;
    if (message.type === 'setWorkflow') {
      if (message.workflow !== 'normal' && message.workflow !== 'review') return;
      if (message.workflow === 'normal' && this.activeSession().workflow === 'review') {
        this.choosingWorkflow = true;
        try {
          const choice = await vscode.window.showWarningMessage(
            'Leave read-only Review mode? Normal mode can edit files and run commands according to your approval setting.',
            { modal: true }, 'Enable normal mode',
          );
          if (choice !== 'Enable normal mode') return;
          this.activeSession().workflow = 'normal';
          await this.persist();
        } finally {
          this.choosingWorkflow = false;
          this.postWorkflow();
        }
        return;
      }
      this.activeSession().workflow = message.workflow;
      await this.persist();
      this.postWorkflow();
      return;
    }
    if (message.type === 'selectWorkspace') { await this.selectWorkspace(); return; }
    if (message.type === 'setApiMode' && ['chat-completions', 'responses'].includes(message.apiMode ?? '')) {
      const key = getConfig().backend === 'remote' ? 'remote.apiMode' : 'apiMode';
      await vscode.workspace.getConfiguration('deeplocal').update(key, message.apiMode, vscode.ConfigurationTarget.Global);
      await this.sendModels();
      return;
    }
    if (message.type === 'setSummary' && ['off', 'auto'].includes(message.summary ?? '')) {
      await vscode.workspace.getConfiguration('deeplocal').update('reasoningSummary', message.summary, vscode.ConfigurationTarget.Global);
      await this.sendModels();
      return;
    }
    if (message.type === 'setApprovalMode' && ['every', 'safe', 'full', 'ask'].includes(message.approvalMode ?? '')) {
      await vscode.workspace.getConfiguration('deeplocal').update('approvalMode', message.approvalMode, vscode.ConfigurationTarget.Global);
      this.post({ type: 'permissionMode', approvalMode: message.approvalMode });
      return;
    }
    if (message.type === 'setBackend') {
      const selected = await vscode.window.showQuickPick([
        { label: 'Local DeepLocal', description: 'http://127.0.0.1:14567/v1', value: 'local' },
        { label: 'Remote OpenAI-compatible API', description: 'May incur provider charges', value: 'remote' },
      ], { placeHolder: 'Choose inference backend' });
      if (selected) {
        await vscode.workspace.getConfiguration('deeplocal').update('backend', selected.value, vscode.ConfigurationTarget.Global);
        await this.sendModels();
      }
      return;
    }
    if (message.type === 'setRemoteApiKey') {
      const key = await vscode.window.showInputBox({
        prompt: 'Remote API key (stored securely in VS Code SecretStorage)',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Paste API key',
      });
      if (key !== undefined) {
        const normalizedKey = key.trim();
        if (!normalizedKey) {
          this.post({ type: 'error', message: 'API key cannot be empty.' });
          return;
        }
        await this.remoteApiKey.set(normalizedKey);
        await this.sendModels();
        this.post({ type: 'notice', message: 'Remote API key stored securely.' });
      }
      return;
    }
    if (message.type === 'clearRemoteApiKey') {
      await this.remoteApiKey.clear();
      this.post({ type: 'notice', message: 'Remote API key cleared.' });
      return;
    }
    if (message.type === 'ready' || message.type === 'refreshModels') {
      await this.sendModels();
      this.postSessions();
      this.restoreTranscript();
      return;
    }

    if (message.type === 'switchSession' && message.sessionId) {
      const target = this.sessions.find(session => session.id === message.sessionId);
      if (!target) return;
      // Session navigation cannot silently re-enable the normal tool dispatcher.
      if (this.activeSession().workflow === 'review') target.workflow = 'review';
      this.activeSessionId = message.sessionId;
      await this.persist();
      this.postSessions();
      this.restoreTranscript();
      return;
    }

    if (message.type === 'newSession') {
      await this.newSession();
      return;
    }

    if (message.type === 'deleteSession') {
      await this.deleteSession(message.sessionId);
      return;
    }

    if (message.type !== 'send') {
      return;
    }

    const text = message.text?.trim() ?? '';
    const model = message.model?.trim();
    if (!model) {
      return;
    }

    if (this.activeSession().workflow === 'review') {
      await this.sendReview(model, text, message.review);
      return;
    }
    if (!text) return;

    await this.sendPrompt(model, text, message.useAgent !== false);
  }

  private async sendModels(): Promise<void> {
    try {
      const models = await this.client.listModels();
      this.post({
        type: 'models',
        models: models.map((model) => model.id),
        backend: getConfig().backend,
        hasApiKey: getConfig().backend === 'remote' ? Boolean(await this.remoteApiKey.get()) : false,
        baseUrl: getConfig().baseUrl,
        apiMode: getConfig().apiMode ?? 'chat-completions',
        reasoningSummary: getConfig().reasoningSummary ?? 'auto',
        approvalMode: getConfig().approvalMode,
      });
    } catch (error) {
      this.postError(`Failed to load ${getConfig().backend === 'remote' ? 'remote' : 'DeepLocal'} models: ${messageOf(error)}`);
    }
  }

  private postWorkflow(): void {
    this.post({ type: 'workflow', workflow: this.activeSession().workflow ?? 'normal' });
  }

  private async sendReview(model: string, focus: string, input?: ReviewRequest): Promise<void> {
    let outcome: 'success' | 'error' | 'cancelled' = 'error';
    const requestId = createId();
    const controller = new AbortController();
    const session = this.activeSession();
    this.activeRequestId = requestId;
    this.taskController = controller;
    this.post({ type: 'assistantStart', agent: true, review: true });
    try {
      const request = input ?? { source: 'unstaged' };
      if (!['unstaged', 'staged', 'commits'].includes(request.source)) throw new Error('Choose a valid review source.');
      if (!this.client.modelInformation(model).toolCalling) throw new Error('Select a tool-capable model for Review mode.');
      const folder = this.currentWorkspace();
      if (!folder || this.choosingWorkspace) throw new Error('Open or choose a workspace folder before starting a review.');
      if (folder.uri.scheme !== 'file') throw new Error('Git review requires a local filesystem workspace.');
      this.taskWorkspace = folder;
      this.postWorkspace();
      const title = `Review ${request.source === 'commits' ? 'commit range' : request.source + ' changes'}`;
      session.transcript.push({ role: 'You', text: focus || title });
      if (session.transcript.length === 1) session.title = makeTitle(focus || title);
      session.updatedAt = Date.now();
      await this.persist();
      this.postSessions();
      this.post({ type: 'status', message: 'Collecting Git changes…' });
      const source = await createGitReview(folder.uri.fsPath, request, controller.signal);
      controller.signal.throwIfAborted();
      requireWorkspaceFolder(folder);
      if (!source.files.length) {
        const text = [`No ${request.source === 'commits' ? 'commit-range' : request.source} changes to review. Untracked files and unsaved editor buffers are excluded. No model request was made; tests were not run.`, ...source.limitations].join('\n');
        session.transcript.push({ role: 'DeepLocal', text });
        this.post({ type: 'assistantFinal', text });
      } else {
        const report = await runReview({
          requestId, model, source, focus, signal: controller.signal,
          maxTurns: getConfig().agentMaxTurns,
          maxOutputTokens: getConfig().maxOutputTokens,
          stream: (id, request) => this.client.streamChat(id, request),
          onProgress: text => { requireWorkspaceFolder(folder); this.post({ type: 'status', message: text }); },
          onTool: (name, _content) => { this.post({ type: 'status', message: `Review · ${name}` }); },
        });
        controller.signal.throwIfAborted();
        requireWorkspaceFolder(folder);
        const id = createId();
        const text = formatReviewReport(report);
        session.transcript.push({ role: 'DeepLocal', id, text, reviewReport: report });
        this.post({ type: 'reviewResult', id, text, report });
      }
      session.updatedAt = Date.now();
      await this.persist();
      this.postSessions();
      outcome = 'success';
    } catch (error) {
      outcome = controller.signal.aborted ? 'cancelled' : 'error';
      if (controller.signal.aborted) this.post({ type: 'notice', message: 'Review stopped. No file changes or commands were performed.' });
      else this.postError(`Review failed: ${messageOf(error)}`);
    } finally {
      this.activeRequestId = undefined;
      this.taskController = undefined;
      this.taskWorkspace = undefined;
      this.postWorkspace();
      this.post({ type: 'assistantDone', outcome, review: true });
    }
  }

  private async openReviewReference(reportId: string | undefined, findingIndex: number | undefined): Promise<void> {
    if (!Number.isInteger(findingIndex) || findingIndex! < 0) return;
    const report = this.activeSession().transcript.find(item => item.id === reportId)?.reviewReport;
    const finding = report?.findings[findingIndex!];
    if (!report || !finding) return;
    const source = report.sources.find(item => item.path === finding.path && item.side === finding.side);
    if (!source) return;
    // A content provider opens the reviewed snapshot, never the mutable checkout.
    const uri = vscode.Uri.parse(`deeplocal-review:/${finding.path.split('/').map(encodeURIComponent).join('/')}?side=${finding.side}&snapshot=${createId()}`);
    const key = uri.toString();
    this.reviewDocuments.set(key, source.content);
    // Keep recent snapshots available without registering a provider for each navigation.
    if (this.reviewDocuments.size > 128) {
      const oldest = this.reviewDocuments.keys().next().value;
      if (oldest !== undefined) this.reviewDocuments.delete(oldest);
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        preview: true,
        selection: new vscode.Range(finding.startLine - 1, 0, finding.endLine - 1, 0),
      });
    } catch (error) {
      this.reviewDocuments.delete(key);
      throw error;
    }
  }

  private async sendPrompt(model: string, text: string, useAgent: boolean): Promise<void> {
    const permissionMode = getConfig().approvalMode ?? 'safe';
    const operationsAllowed = permissionMode !== 'ask';
    const effectiveAgent = useAgent && operationsAllowed;
    const session = this.activeSession();
    const information = this.client.modelInformation(model);
    if (effectiveAgent && !information.toolCalling) {
      this.postError(`${information.reason} Select a tool-capable model for Agent mode, or choose Chat mode.`);
      this.post({ type: 'assistantDone' });
      return;
    }
    const folder = this.currentWorkspace();
    if (effectiveAgent && (!folder || this.choosingWorkspace)) {
      this.postWorkspace();
      this.postError(this.choosingWorkspace ? 'Finish choosing a workspace folder before starting a task.' : 'Open or choose a workspace folder before starting an agent task.');
      this.post({ type: 'assistantDone' });
      return;
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.activeRequestId = requestId;
    const controller = new AbortController();
    this.taskController = controller;
    this.taskWorkspace = effectiveAgent ? folder : undefined;
    this.postWorkspace();
    const userMessage = text;
    const assistantItem: PersistedChatItem = { role: 'DeepLocal', text: '' };
    const evidence = new TaskEvidence();
    let finalContext: ResponseContext | undefined;
    const onContext = (context: ResponseContext) => { finalContext = context; };
    const summaries = new Map<string, PersistedChatItem>();
    const onSummary = (event: Extract<StreamEvent, { kind: 'summary' }>) => {
      controller.signal.throwIfAborted();
      const id = `${requestId}:${event.id}`;
      let item = summaries.get(id);
      if (!item) {
        item = { role: 'Summary', id, text: '' };
        summaries.set(id, item);
        session.transcript.push(item);
      }
      item.text += event.value;
      this.post({ type: 'summaryDelta', id, text: event.value });
      session.updatedAt = Date.now();
      this.schedulePersist();
    };
    let answer = '';
    let outcome: 'success' | 'error' | 'cancelled' = 'success';
    try {
      session.history.push({ role: 'user', content: userMessage });
      session.transcript.push({ role: 'You', text });
      if (session.transcript.length === 1) {
        session.title = makeTitle(text);
      }
      session.updatedAt = Date.now();
      await this.persist();
      this.postSessions();

      session.transcript.push(assistantItem);
      await this.persist();

      this.post({ type: 'assistantStart', agent: effectiveAgent });

      const messages = [...session.history];
      if ((effectiveAgent || getConfig().injectSystemPrompt) && messages[0]?.role !== 'system') {
        messages.unshift({
          role: 'system',
          content: [
            'You are DeepLocal, a coding assistant inside VS Code.',
            'Automatically use the user’s conversational language for progress updates, explanations, and the final answer. Respect explicit requests for a different response language. Short acknowledgements, quoted text, code and logs do not change the conversation language. Never ask the user to select a language in settings. Keep code, paths and command output unchanged.',
            effectiveAgent ? 'You are in Agent mode. Execute requested work using tools, then report actual results. Do not print full file contents in chat when asked to implement something.' : permissionMode === 'ask' ? 'You are in Ask-only mode. Analyze, explain, and suggest changes, but do not claim to have performed operations.' : 'You are in Chat mode. Explain and discuss; no file changes or commands are available.',
            'Inspect the workspace before changing files. Paths are relative to the workspace root.',
            'When asked to create a new file, use create_file with an appropriate new path. Never replace the active file merely because it is open.',
            'Read existing files before editing. Use replace_in_file for targeted changes; write_file for intentional full replacements.',
            'Before changing imports, inspect the surrounding declarations and symbol usages. Modify an existing import instead of adding an equivalent binding. Preserve value imports for constructors, static access and instanceof; use type-only imports only where compatible with runtime usage and the workspace ESLint configuration.',
            'Use delete_file only when the user explicitly requests deletion; it moves a single file to the trash after approval. Never delete files as an incidental cleanup step.',
            'Use get_active_file and get_selection before editing the active editor when relevant.',
            'TypeScript file tools reject new duplicate import bindings and report observed diagnostic changes after saving. A saved edit can still have validation errors. Read each tool result, repair newly reported errors with targeted edits, and never blindly retry a rejected write. A reduction in lint warnings does not compensate for new compilation errors.',
            'Use get_diagnostics and relevant workspace build, lint and test commands to verify fixes. Automatic diagnostic observations are bounded and may be inconclusive; they are not proof of successful compilation. If existing errors remain, report them and do not claim that all errors are fixed. Report exactly which verification commands ran.',
            'For source changes, call discover_verification_commands before selecting checks. It inspects package scripts and common project metadata, applies deeplocal.verificationPreferences, and reports unsafe or missing checks without executing anything. Run only relevant discovered commands, preserve each category as a separate verification:true check, and never invent scripts. Do not automatically run installation, deployment, publishing, release, migration, or destructive commands; these require explicit approval.',
            'For source changes, inspect existing project scripts and mark relevant run_command calls with verification:true. Inspect the complete result, including stdout, stderr, exit status and incomplete-output flags. Recoverable verification failures require targeted repair and another check within the host repair limit. Never replace a failed build with a passing lint result. Explanation-only tasks do not need verification. Do not blindly repeat an unchanged failed command or retry denied actions.',
            'Prefer small targeted edits. Before each group of tool calls, give a brief user-visible progress update (one or two sentences) describing what you are about to inspect or change and why. After tools return, summarize relevant findings and the next step. These are concise action summaries, not private chain-of-thought or hidden reasoning. Explain what changed after tools finish.',
            'Ask before destructive work; file write and command tools already require user confirmation.',
            'After creating a file, use open_file if appropriate. Check diagnostics or run relevant tests. Report whether verification actually ran.',
            'If a tool fails or is declined, respect that result and never claim that the action succeeded. Answer in the user’s language.',
            'In Agent mode, finish with submit_completion, as the only tool call in that turn, even when no tools ran. List exact command/args for every requested or declared verification check, including any build/test not run. The host records all attempts and derives canonical states. Use nextSteps only for actionable suggestions in the user’s conversational language; no free-form success summary. A passed declared command does not prove that all project errors are fixed.',
          ].join('\n'),
        });
      }

      if (effectiveAgent && folder) {
        messages.unshift({ role: 'system', content: `Active workspace folder for this task: ${folder.name} (${folder.uri.toString()}). All tool paths are relative to this root. Earlier history may refer to other roots; inspect this folder before acting.` });
      }

      const onDelta = (delta: string) => {
        controller.signal.throwIfAborted();
        assistantItem.text += delta;
        session.updatedAt = Date.now();
        this.schedulePersist();
      };
      controller.signal.throwIfAborted();
      answer = effectiveAgent
        ? await this.runAgentRequest(requestId, model, messages, onDelta, controller.signal, session, assistantItem, onSummary, folder!, evidence)
        : await this.runChatRequest(requestId, model, messages, onDelta, onSummary, onContext);
      controller.signal.throwIfAborted();

      session.history.push({ role: 'assistant', content: answer, ...(finalContext ? { responseContext: finalContext } : {}) });
      assistantItem.text = answer;
      // Keep the final summary after the actions in both live and restored views.
      session.transcript = session.transcript.filter((item) => item !== assistantItem);
      session.transcript.push(assistantItem);
      this.post({ type: 'assistantFinal', text: answer, ...(assistantItem.completionReport ? { completionReport: assistantItem.completionReport } : {}) });
      session.updatedAt = Date.now();
      await this.persist();
      this.postSessions();
    } catch (error) {
      outcome = controller.signal.aborted ? 'cancelled' : 'error';
      if (effectiveAgent) {
        const report = evidence.report(undefined, controller.signal.aborted ? 'Task stopped; partial changes and attempted tool results are retained.' : messageOf(error));
        assistantItem.completionReport = report;
        assistantItem.text = formatCompletion(report);
        session.transcript = session.transcript.filter(item => item !== assistantItem);
        session.transcript.push(assistantItem);
        session.history.push({ role: 'assistant', content: assistantItem.text });
        this.post({ type: 'assistantFinal', text: assistantItem.text, completionReport: report });
        await this.persist();
        return;
      }
      if (useAgent && assistantItem.text.trim()) {
        assistantItem.role = 'Reasoning';
        session.transcript = session.transcript.filter((item) => item !== assistantItem);
        session.transcript.push(assistantItem);
      }
      if (controller.signal.aborted) {
        this.post({ type: 'notice', message: 'Task stopped. Already applied changes are retained.' });
      } else {
        this.logger.error(`DeepLocal chat failed: ${messageOf(error)}`);
        this.postError(`DeepLocal chat failed: ${messageOf(error)}`);
      }
      if (!assistantItem.text.trim()) {
        session.transcript = session.transcript.filter((item) => item !== assistantItem);
      }
      await this.persist();
    } finally {
      this.subagents?.stop();
      this.subagents = undefined;
      this.activeRequestId = undefined;
      this.taskController = undefined;
      this.taskWorkspace = undefined;
      this.postWorkspace();
      this.post({ type: 'assistantDone', outcome });
    }
  }

  private async runChatRequest(
    requestId: string,
    model: string,
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
    onSummary: (event: Extract<StreamEvent, { kind: 'summary' }>) => void,
    onContext: (context: ResponseContext) => void,
  ): Promise<string> {
    let answer = '';
    for await (const event of this.client.streamChat(requestId, {
      model,
      messages,
      stream: true,
      max_tokens: getConfig().maxOutputTokens,
    })) {
      if (event.kind === 'summary') onSummary(event);
      if (event.kind === 'responseContext') onContext(event.value);
      if (event.kind !== 'text') {
        continue;
      }
      answer += event.value;
      onDelta(event.value);
      this.post({ type: 'assistantDelta', text: event.value });
    }
    return answer;
  }

  private async runAgentRequest(
    requestId: string,
    model: string,
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
    signal: AbortSignal,
    session: ChatSession,
    assistantItem: PersistedChatItem,
    onSummary: (event: Extract<StreamEvent, { kind: 'summary' }>) => void,
    folder: vscode.WorkspaceFolder,
    evidence: TaskEvidence,
  ): Promise<string> {
    const workingMessages = [...messages];
    const config = getConfig();
    const limits = { ...DEFAULT_SUBAGENT_LIMITS, ...config.subagents };
    const childItems = new Map<string, PersistedChatItem>();
    const childSources = new Map<SubagentTask, Map<string, string>>();
    const subagents = limits.enabled ? new SubagentManager({
      requestId, model, signal, limits,
      maxOutputTokens: Math.min(config.maxOutputTokens, this.client.modelInformation(model).maxOutputTokens ?? config.maxOutputTokens),
      stream: (id, request) => {
        const current = getConfig();
        if (current.backend !== config.backend || current.baseUrl !== config.baseUrl || current.apiMode !== config.apiMode) {
          throw new Error('Research backend configuration changed; start a new task.');
        }
        return this.client.streamChat(id, request);
      },
      cancel: id => this.client.cancel(id),
      reserve: (calls, agentId) => evidence.reserve(calls, agentId),
      invoke: async (task, call, childSignal) => {
        childSignal.throwIfAborted();
        requireWorkspaceFolder(folder);
        const result = await invokeAgentTool(call.id, call.function.name, call.function.arguments, {
          signal: childSignal, workspaceFolder: folder,
          researchPolicy: { tools: task.tools, paths: task.paths },
          approvalMode: getConfig().approvalMode ?? 'safe',
          approve: (message, preview) => this.requestApproval(`Research: ${task.title}\n${message}`, childSignal, preview),
        });
        const sources = childSources.get(task) ?? new Map<string, string>();
        for (const source of result.researchSources ?? []) {
          if (sources.has(source.path) && sources.get(source.path) !== source.digest) throw new Error('Research evidence changed during investigation.');
          sources.set(source.path, source.digest);
        }
        if (sources.size > 500) throw new ResearchLimitError('Research source observation limit reached.');
        childSources.set(task, sources);
        return result;
      },
      verify: (task, childSignal) => verifyResearchSources(
        [...(childSources.get(task) ?? [])].map(([path, digest]) => ({ path, digest })),
        { signal: childSignal, workspaceFolder: folder, researchPolicy: { tools: task.tools, paths: task.paths } }),
      onActivity: activity => {
        if (this.activeRequestId !== requestId) return;
        let item = childItems.get(activity.id);
        if (!item) {
          item = { role: 'Tool', id: activity.id, text: '', subagent: activity };
          childItems.set(activity.id, item);
          session.transcript.push(item);
        }
        item.subagent = structuredClone(activity);
        item.text = activity.result ? JSON.stringify(activity.result, null, 2) : '';
        session.updatedAt = Date.now();
        this.post({ type: 'subagent', activity });
        this.schedulePersist();
      },
    }) : undefined;
    this.subagents = subagents;
    if (subagents) workingMessages.push({ role: 'system', content: 'For independent research, use delegate_research with explicit objectives, minimal context, allowed workspace-relative files or directory prefixes, and only the needed research tools. Children cannot edit, execute commands, or delegate. Their attributed findings are model conclusions supported by observed evidence, never proof that builds or tests ran. Wait for results and inspect limitations before acting. Do not delegate dependent work or copy conversation history into child context.' });
    const repairLimit = getConfig().agentMaxRepairIterations ?? 3;
    const repair = new AgentRepair(repairLimit);
    let completionRaw: string | undefined;
    const finish = (limitation?: string): string => {
      const report = evidence.report(completionRaw);
      if (limitation) report.limitation = limitation;
      assistantItem.completionReport = report;
      assistantItem.text = '';
      return formatCompletion(report);
    };
    let finalAnswer = '';

    for (let turn = 0; turn < getConfig().agentMaxTurns; turn += 1) {
      signal.throwIfAborted();
      requireWorkspaceFolder(folder);
      if (repair.stopped) { finalAnswer = finish(repair.stopped); break; }
      session.transcript = session.transcript.filter((item) => item !== assistantItem);
      session.transcript.push(assistantItem);
      this.post({ type: 'status', message: `Working · step ${turn + 1}` });
      this.post({ type: 'reasoningStart' });
      let answer = '';
      let responseContext: ResponseContext | undefined;
      const toolCalls: ToolCall[] = [];

      for await (const event of this.client.streamChat(requestId, {
        model,
        messages: workingMessages,
        stream: true,
        max_tokens: getConfig().maxOutputTokens,
        tools: [...getAgentTools(), ...(subagents ? [delegationTool()] : []), completionTool()],
        tool_choice: 'auto',
      })) {
        if (event.kind === 'text') {
          answer += event.value;
        } else if (event.kind === 'toolCall') {
          toolCalls.push(event.value);
          if (toolCalls.length > 32) throw new Error('Task tool-call limit reached; verification is incomplete.');
        } else if (event.kind === 'summary') {
          onSummary(event);
        } else if (event.kind === 'responseContext') {
          responseContext = event.value;
        }
      }

      if (!toolCalls.length) {
        // An agent can hallucinate a passed build before its first tool, too.
        // Chat/Ask keep prose; Agent completions require observed evidence.
        if (!answer.trim()) throw new Error('The model returned no answer or tool actions. Retry or choose another model.');
        const guidance = repair.completion(evidence.repairState());
        if (guidance) {
          // Do not replay unchecked final prose (including opaque Responses output).
          workingMessages.push({ role: 'system', content: guidance });
          assistantItem.text = '';
          this.post({ type: 'status', message: 'Verification unresolved · continuing repair' });
          await this.persist();
          continue;
        }
        finalAnswer = finish(repair.stopped);
        break;
      }

      evidence.reserve(toolCalls);
      const submission = toolCalls.find(call => call.function.name === 'submit_completion');
      if (submission) {
        if (toolCalls.length !== 1) throw new Error('submit_completion must be the only tool call in the final turn.');
        // Validate and register declarations before checking whether completion is allowed.
        const proposed = evidence.report(submission.function.arguments);
        completionRaw = submission.function.arguments;
        const guidance = repair.completion(evidence.repairState());
        if (guidance && !proposed.limitation) {
          const continuation: ChatMessage[] = [
            { role: 'assistant', content: null, tool_calls: toolCalls, ...(responseContext ? { responseContext } : {}) },
            { role: 'tool', tool_call_id: submission.id, content: guidance },
          ];
          workingMessages.push(...continuation);
          session.history.push(...continuation);
          assistantItem.text = '';
          this.post({ type: 'status', message: 'Verification unresolved · continuing repair' });
          await this.persist();
          continue;
        }
        finalAnswer = finish(repair.stopped);
        break;
      }
      if (answer.trim()) {
        onDelta(answer);
        this.post({ type: 'reasoningDelta', text: answer });
        session.transcript.push({ role: 'Reasoning', text: answer });
      }
      assistantItem.text = '';

      workingMessages.push({
        role: 'assistant',
        content: answer || null,
        tool_calls: toolCalls,
        ...(responseContext ? { responseContext } : {}),
      });

      const results = [];
      for (const call of toolCalls) {
        if (signal.aborted) {
          const skipped = { callId: call.id, name: call.function.name, content: 'Task stopped; tool was not executed.', status: 'error' as const };
          results.push(skipped);
          evidence.record(call, skipped, false);
          continue;
        }
        const activity = toolActivity(`${requestId}:${turn}:${call.id}`, call);
        this.post({ type: 'status', message: `${activity.title}${activity.detail ? ` · ${activity.detail}` : ''}` });
        this.post({ type: 'toolStart', activity });
        const mutating = ['create_file', 'write_file', 'replace_in_file', 'delete_file'].includes(call.function.name);
        const retryBlock = repair.stopped ?? evidence.commandRetryBlock(call) ?? (mutating ? repair.beforeMutation() : undefined);
        if (retryBlock) repair.stop(retryBlock);
        const result: AgentToolResult = retryBlock
          ? { callId: call.id, name: call.function.name, content: `${retryBlock} Tool was not executed.`, status: 'error' as const }
          : call.function.name === 'delegate_research'
            ? await this.delegateResearch(subagents, call)
            : await invokeAgentTool(call.id, call.function.name, call.function.arguments, {
          signal,
          workspaceFolder: folder,
          approvalMode: getConfig().approvalMode ?? 'safe',
          approve: (message, preview) => this.requestApproval(message, signal, preview),
        });
        evidence.record(call, result, !retryBlock);
        if (result.status === 'declined' && repairLimit > 0) {
          repair.stop('The user declined an action. Verification is blocked; no automatic retry was made.');
        }
        repair.observe(evidence.repairState());
        results.push(result);
        activity.state = signal.aborted ? 'cancelled' : result.status;
        if (call.function.name === 'write_file' && result.status === 'success') {
          activity.title = result.content.startsWith('Created ') ? 'Create file' : 'Modify file';
        }
        const text = `${call.function.name}\n${result.content}`;
        session.transcript.push({ role: 'Tool', text, activity });
        this.post({ type: 'toolResult', text, activity });
        await this.persist();
      }
      workingMessages.push(...toolResultsToMessages(results));
      // Preserve complete assistant/tool groups for follow-up requests.
      session.history.push(...workingMessages.slice(workingMessages.length - results.length - 1));
      signal.throwIfAborted();
    }

    if (!finalAnswer && repair.stopped) finalAnswer = finish(repair.stopped);
    if (!finalAnswer) throw new Error('Agent safety limit reached after many tool steps. Work may be incomplete; review the tool results and ask to continue.');
    return finalAnswer;
  }

  private stopTask(): void {
    this.taskController?.abort();
    this.subagents?.stop();
    if (this.activeRequestId) this.client.cancel(this.activeRequestId);
    for (const entry of this.approvalQueue.splice(0)) entry.cancel();
    this.pendingApproval?.resolve(false);
  }

  private async delegateResearch(manager: SubagentManager | undefined, call: ToolCall): Promise<AgentToolResult> {
    if (!manager) return { callId: call.id, name: call.function.name, status: 'error', content: 'Parallel research is disabled for this task.' };
    try {
      const research = await manager.run(call.function.arguments);
      return { callId: call.id, name: call.function.name, research,
        status: research.state === 'completed' ? 'success' : 'error', content: JSON.stringify(research) };
    } catch (error) {
      return { callId: call.id, name: call.function.name, status: 'error', content: `Research was not completed: ${messageOf(error)}` };
    }
  }

  private nextApproval(): void {
    if (!this.pendingApproval && !this.taskController?.signal.aborted) this.approvalQueue.shift()?.start();
  }

  private requestApproval(message: string, signal: AbortSignal, preview?: () => Promise<void>): Promise<boolean> {
    signal.throwIfAborted();
    return new Promise((resolve) => {
      const id = createId();
      let shown = false;
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        const index = this.approvalQueue.indexOf(entry);
        if (index >= 0) this.approvalQueue.splice(index, 1);
        if (this.pendingApproval?.id === id) this.pendingApproval = undefined;
        if (shown) this.post({ type: 'approvalDone', approvalId: id, approved });
        resolve(approved);
        this.nextApproval();
      };
      const onAbort = () => finish(false);
      const entry = {
        cancel: () => finish(false),
        start: () => {
          if (signal.aborted) { finish(false); return; }
          shown = true;
          this.pendingApproval = { id, resolve: finish, preview };
          this.post({ type: 'approval', approvalId: id, message, hasPreview: Boolean(preview) });
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.approvalQueue.push(entry);
      this.nextApproval();
    });
  }

  private postError(message: string): void {
    this.post({ type: 'error', message });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private restoreTranscript(): void {
    const session = repairTranscript(this.activeSession());
    this.postWorkflow();
    const items = session.transcript.map(item => item.activity
      ? { ...item, activity: { ...item.activity, detail: redactToolActivityDetail(item.activity.detail) } }
      : item);
    this.post({ type: 'restore', items });
  }


  private postSessions(): void {
    this.post({
      type: 'sessions',
      activeSessionId: this.activeSessionId,
      sessions: this.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        preview: sessionPreview(session),
        updatedAt: session.updatedAt,
      })),
    });
  }

  private async persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    for (const session of this.sessions) {
      repairTranscript(session);
      if (session.history.length > 40) {
        const boundary = session.history.findIndex((message, index) => index >= session.history.length - 40 && message.role === 'user');
        if (boundary > 0) session.history = session.history.slice(boundary);
      }
      session.transcript = session.transcript.slice(-80);
    }
    this.sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    this.sessions = this.sessions.slice(0, 20);
    await this.context.workspaceState.update(this.scopedSessionsKey, this.sessions);
    await this.context.workspaceState.update(this.scopedActiveSessionKey, this.activeSessionId);
  }

  private async deleteSession(sessionId: string | undefined): Promise<void> {
    const target = this.sessions.find((session) => session.id === sessionId);
    if (!target) {
      return;
    }
    const workflow = this.activeSession().workflow;

    const choice = await vscode.window.showWarningMessage(
      `Delete DeepLocal session "${target.title}"?`,
      { modal: true },
      'Delete',
    );
    if (choice !== 'Delete') {
      return;
    }

    this.sessions = this.sessions.filter((session) => session.id !== target.id);
    if (!this.sessions.length) {
      this.sessions.push(createSession());
    }

    if (this.activeSessionId === target.id) {
      this.activeSessionId = this.sessions[0].id;
    }
    if (workflow === 'review') this.activeSession().workflow = 'review';

    await this.persist();
    this.postSessions();
    this.restoreTranscript();
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 750);
  }

  private activeSession(): ChatSession {
    let session = this.sessions.find((item) => item.id === this.activeSessionId);
    if (!session) {
      session = createSession();
      this.sessions.unshift(session);
      this.activeSessionId = session.id;
    }
    return session;
  }

  private loadSessions(): ChatSession[] {
    const sessions = this.context.workspaceState.get<ChatSession[]>(this.scopedSessionsKey, []);
    if (sessions.length) {
      return sessions;
    }

    // workspaceState is deliberately the source of truth. Migrate the old global
    // values only when this workspace has no scoped data yet. Since the old
    // format had no workspace identity, it is assigned to the first workspace
    // opened after upgrade; the original values are retained for recovery.
    const oldSessions = this.context.globalState.get<ChatSession[]>(ChatPanel.sessionsKey, []);
    const oldHistory = this.context.globalState.get<ChatMessage[]>(ChatPanel.historyKey, []);
    const oldTranscript = this.context.globalState.get<PersistedChatItem[]>(ChatPanel.transcriptKey, []);
    const migrated = this.context.globalState.get<boolean>(ChatPanel.migrationKey, false);
    if (!migrated && oldSessions.length) {
      void this.context.workspaceState.update(this.scopedSessionsKey, oldSessions);
      void this.context.globalState.update(ChatPanel.migrationKey, true);
      return oldSessions;
    }
    if (oldHistory.length || oldTranscript.length) {
      const migratedSession = {
        id: createId(),
        title: oldTranscript[0]?.text ? makeTitle(oldTranscript[0].text) : 'Previous session',
        updatedAt: Date.now(),
        history: oldHistory,
        transcript: oldTranscript,
      };
      void this.context.workspaceState.update(this.scopedSessionsKey, [migratedSession]);
      void this.context.globalState.update(ChatPanel.migrationKey, true);
      return [migratedSession];
    }

    return [createSession()];
  }

}

/** Stable scope used by persistence and diagnostics. Empty windows intentionally
 * share one scope because VS Code gives them no durable workspace identity. */
export function workspaceIdentity(workspace: Pick<typeof vscode.workspace, 'workspaceFile' | 'workspaceFolders'> = vscode.workspace): string {
  if (workspace.workspaceFile) {
    return `workspace:${workspace.workspaceFile.toString()}`;
  }
  const folders = workspace.workspaceFolders?.map((folder) => folder.uri.toString()).sort();
  return folders?.length ? `folders:${folders.join('|')}` : 'empty';
}

function createSession(): ChatSession {
  return {
    id: createId(),
    title: 'New session',
    updatedAt: Date.now(),
    history: [],
    transcript: [],
  };
}

/** Saved workers have no running process after an Extension Host restart. */
function interruptResearch(session: ChatSession): ChatSession {
  for (const item of session.transcript) {
    if (!item.subagent || !['queued', 'running'].includes(item.subagent.state)) continue;
    const result = { id: item.subagent.id, title: item.subagent.title, state: 'cancelled' as const,
      findings: [], limitations: ['Research interrupted by restart; it was not resumed.'], durationMs: 0, testsRun: false as const };
    item.subagent = { ...item.subagent, state: 'cancelled', result };
    item.text = JSON.stringify(result, null, 2);
  }
  return session;
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sessionPreview(session: ChatSession): string {
  // Visible requests also cover Review mode, which keeps model history separate.
  for (let index = session.transcript.length - 1; index >= 0; index--) {
    const item = session.transcript[index];
    if (item.role === 'You') return item.text;
  }
  // A long tool run can push the user row outside the retained transcript.
  for (let index = session.history.length - 1; index >= 0; index--) {
    const message = session.history[index];
    if (message.role === 'user') return typeof message.content === 'string' ? message.content : '';
  }
  return '';
}

function makeTitle(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 42 ? `${compact.slice(0, 39)}...` : compact || 'New session';
}

function repairTranscript(session: ChatSession): ChatSession {
  const assistantTranscriptCount = session.transcript.filter((item) => item.role === 'DeepLocal').length;
  const assistantHistory = session.history
    .filter((message) => message.role === 'assistant' && !message.tool_calls?.length && typeof message.content === 'string' && message.content.trim())
    .map((message) => message.content as string);

  if (assistantTranscriptCount >= assistantHistory.length) {
    return session;
  }

  const rebuilt: PersistedChatItem[] = [];
  let visibleUserIndex = 0;
  let visibleAssistantIndex = 0;
  const visibleUsers = session.transcript.filter((item) => item.role === 'You');

  for (const message of session.history) {
    if (message.role === 'user') {
      const visible = visibleUsers[visibleUserIndex];
      visibleUserIndex += 1;
      rebuilt.push(visible ?? { role: 'You', text: summarizeUserMessage(message.content) });
    }

    if (message.role === 'assistant' && !message.tool_calls?.length && typeof message.content === 'string' && message.content.trim()) {
      rebuilt.push({ role: 'DeepLocal', text: assistantHistory[visibleAssistantIndex] });
      visibleAssistantIndex += 1;
    }
  }

  session.transcript = rebuilt.length ? rebuilt : session.transcript;
  return session;
}

function summarizeUserMessage(content: string | null | undefined): string {
  if (!content) {
    return '';
  }

  const firstLine = content.split(/\r?\n/).find((line) => line.trim());
  return firstLine?.trim() ?? '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
