import * as vscode from 'vscode';
import { ChatPanel } from './chat-panel';
import { getConfig } from './config';
import { DeepLocalClient } from './deeplocal-client';
import { DeepLocalProvider } from './deeplocal-provider';
import { Logger } from './logger';

let provider: DeepLocalProvider | undefined;
let chatPanel: ChatPanel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('DeepLocal');
  const logger = new Logger(output);
  const client = new DeepLocalClient(logger);

  provider = new DeepLocalProvider(client, logger);
  chatPanel = new ChatPanel(context, client, logger);

  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerWebviewViewProvider('deeplocal-chat-adapter.view', chatPanel),
    vscode.lm.registerLanguageModelChatProvider('deeplocal-chat-adapter', provider),
    vscode.commands.registerCommand('deeplocal-chat-adapter.refreshModels', async () => {
      output.show(true);
      try {
        await provider?.refreshModels();
        vscode.window.showInformationMessage('DeepLocal models refreshed.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Model refresh failed: ${message}`);
        vscode.window.showErrorMessage(`DeepLocal model refresh failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand('deeplocal-chat-adapter.checkConnection', async () => {
      output.show(true);
      logger.info(`Checking DeepLocal at ${getConfig().baseUrl}`);
      const ok = await client.checkConnection();
      if (ok) {
        vscode.window.showInformationMessage('DeepLocal is reachable.');
      } else {
        vscode.window.showWarningMessage('DeepLocal is not reachable. Check the base URL and server status.');
      }
    }),
    vscode.commands.registerCommand('deeplocal-chat-adapter.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'deeplocal');
    }),
    vscode.commands.registerCommand('deeplocal-chat-adapter.open', () => {
      void vscode.commands.executeCommand('workbench.view.extension.deeplocal-chat-adapter-sidebar');
      void vscode.commands.executeCommand('deeplocal-chat-adapter.view.focus');
      void vscode.commands.executeCommand('workbench.action.moveViewToAuxiliaryBar');
    }),
    vscode.commands.registerCommand('deeplocal-chat-adapter.newSession', async () => {
      await chatPanel?.newSession();
      void vscode.commands.executeCommand('workbench.view.extension.deeplocal-chat-adapter-sidebar');
      void vscode.commands.executeCommand('deeplocal-chat-adapter.view.focus');
    }),
  );

  logger.info(`DeepLocal activated, version ${context.extension.packageJSON.version}.`);

  try {
    await provider.refreshModels();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warning(`Initial model refresh failed: ${message}`);
  }
}

export function deactivate(): void {
  provider?.dispose();
  provider = undefined;
  chatPanel = undefined;
}
