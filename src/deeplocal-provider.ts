import * as vscode from 'vscode';
import { getConfig } from './config';
import { DeepLocalClient } from './deeplocal-client';
import { Logger } from './logger';
import { ChatMessage, ChatTool, DeepLocalModel } from './protocol';

interface DeepLocalChatModel extends vscode.LanguageModelChatInformation {
  deeplocalId: string;
}

export class DeepLocalProvider implements vscode.LanguageModelChatProvider<DeepLocalChatModel> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  private models: DeepLocalModel[] = [];

  constructor(
    private readonly client: DeepLocalClient,
    private readonly logger: Logger,
  ) {}

  async refreshModels(): Promise<void> {
    this.models = await this.client.listModels();
    this.logger.info(`Discovered ${this.models.length} DeepLocal model(s).`);
    this.changeEmitter.fire();
  }

  provideLanguageModelChatInformation(): vscode.ProviderResult<DeepLocalChatModel[]> {
    const config = getConfig();

    return this.models.map((model) => ({
      id: model.id,
      deeplocalId: model.id,
      name: displayName(model.id),
      family: 'deeplocal',
      version: '1',
      tooltip: model.id,
      detail: 'DeepLocal',
      maxInputTokens: config.maxInputTokens,
      maxOutputTokens: config.maxOutputTokens,
      capabilities: {
        toolCalling: config.enableToolCalling,
        imageInput: false,
      },
    }));
  }

  async provideLanguageModelChatResponse(
    model: DeepLocalChatModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const config = getConfig();
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const chatMessages = this.toChatMessages(messages);

    if (config.injectSystemPrompt && chatMessages[0]?.role !== 'system') {
      chatMessages.unshift({
        role: 'system',
        content: [
          'You are a concise coding assistant running inside Visual Studio Code.',
          'Answer in the same language as the user unless they ask otherwise.',
          'Do not expose hidden reasoning or internal chain-of-thought.',
        ].join('\n'),
      });
    }

    token.onCancellationRequested(() => this.client.cancel(requestId));

    const tools = config.enableToolCalling ? this.toChatTools(options.tools) : undefined;
    const request = {
      model: model.deeplocalId,
      messages: chatMessages,
      stream: true,
      temperature: numberOption(options.modelOptions?.temperature),
      max_tokens: numberOption(options.modelOptions?.maxOutputTokens) ?? config.maxOutputTokens,
      tools,
      tool_choice: tools && options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' as const : undefined,
    };

    this.logger.debug(`Sending request to DeepLocal model ${model.deeplocalId}.`);

    for await (const event of this.client.streamChat(requestId, request)) {
      if (token.isCancellationRequested) {
        break;
      }

      if (event.kind === 'text') {
        progress.report(new vscode.LanguageModelTextPart(event.value));
      } else {
        progress.report(new vscode.LanguageModelToolCallPart(
          event.value.id,
          event.value.function.name,
          parseToolInput(event.value.function.arguments),
        ));
      }
    }
  }

  async provideTokenCount(
    _model: DeepLocalChatModel,
    text: string | vscode.LanguageModelChatRequestMessage,
  ): Promise<number> {
    const raw = typeof text === 'string' ? text : partsToText(text.content);
    return Math.ceil(raw.length / 4);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private toChatMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): ChatMessage[] {
    const converted: ChatMessage[] = [];

    for (const message of messages) {
      const text = partsToText(message.content);
      const toolCalls = message.content
        .filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart)
        .map((part) => ({
          id: part.callId,
          type: 'function' as const,
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        }));
      const toolResults = message.content
        .filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart);

      for (const result of toolResults) {
        converted.push({
          role: 'tool',
          tool_call_id: result.callId,
          content: partsToText(result.content),
        });
      }

      if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
        converted.push({
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
      } else if (!toolResults.length || text) {
        converted.push({
          role: 'user',
          content: text,
          name: message.name,
        });
      }
    }

    return converted;
  }

  private toChatTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): ChatTool[] | undefined {
    if (!tools?.length) {
      return undefined;
    }

    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    }));
  }
}

function partsToText(parts: ReadonlyArray<vscode.LanguageModelInputPart | unknown>): string {
  return parts.map((part) => {
    if (part instanceof vscode.LanguageModelTextPart) {
      return part.value;
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      return '[Data attachment omitted]';
    }

    return '';
  }).filter(Boolean).join('\n');
}

function parseToolInput(value: string): object {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as object : {};
  } catch {
    return {};
  }
}

function numberOption(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function displayName(modelId: string): string {
  const parts = modelId.split('/').filter(Boolean);
  return parts.at(-1) ?? modelId;
}
