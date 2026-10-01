import { ToolCall } from './protocol';

export interface ToolActivity {
  id: string;
  title: string;
  detail: string;
  state: 'running' | 'success' | 'error' | 'declined' | 'cancelled';
}

const titles: Record<string, string> = {
  create_file: 'Create file', write_file: 'Write file', replace_in_file: 'Modify file', delete_file: 'Delete file',
  read_file: 'Read file', open_file: 'Open file', get_workspace_summary: 'Inspect workspace',
  list_workspace_files: 'List files', search_workspace: 'Search workspace',
  get_active_file: 'Inspect active editor', get_selection: 'Read selection',
  get_diagnostics: 'Check diagnostics', run_command: 'Run command',
};

/** Surface only the action and target, never source code/tool argument payloads. */
export function toolActivity(id: string, call: ToolCall): ToolActivity {
  let detail = '';
  try {
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    const target = args?.path ?? args?.command ?? args?.query ?? args?.pattern;
    if (typeof target === 'string') detail = target.slice(0, 240);
  } catch { /* Malformed input will be reported by the tool executor. */ }
  return { id, title: titles[call.function.name] ?? call.function.name, detail, state: 'running' };
}
