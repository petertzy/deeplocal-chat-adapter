export type DisplayLanguage = 'en' | 'zh-CN';

/** Conservative UI detection: ignore fenced code, URLs and paths; short replies keep the locale. */
export function detectLanguage(text: string, fallback: DisplayLanguage = 'en'): DisplayLanguage {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`]*`/g, '')
    .replace(/^\s*>.*$/gm, '').replace(/https?:\/\/\S+|(?:[\w.-]+[\/\\]|[\/\\])\S*/g, '');
  // An explicit conversational request takes precedence over the surrounding language.
  const requests = [...prose.matchAll(/(?:用|使用)\s*(中文|英文|英语)(?:回答|回复|解释)?|(?:answer|reply|respond|explain)\s+in\s+(Chinese|English)/gi)];
  const requested = requests.at(-1);
  if (requested) return /中文|Chinese/i.test(requested[1] ?? requested[2]) ? 'zh-CN' : 'en';
  // Japanese and Korean prompts should not be classified as Chinese just because they contain Han characters.
  if (/[\u3040-\u30ff\uac00-\ud7af]/u.test(prose)) return fallback;
  if (/[\u3400-\u9fff]/u.test(prose)) return 'zh-CN';
  if (/\b(the|please|could|can|create|build|fix|show|explain|what|how|implement|check|write|update|add|remove|generate|review|why|where|would)\b/i.test(prose)) return 'en';
  return fallback;
}

/** UI copy only. Model text, paths, commands, diffs and provider errors stay verbatim. */
export const chineseUi: Record<string, string> = {
  'DeepLocal Agent': 'DeepLocal 助手', 'New task': '新任务', 'New session': '新会话',
  'Task history': '任务历史', 'Settings': '设置', 'Conversation': '对话',
  'Your workspace, in action': '让工作区动起来', 'What would you like to build?': '你想构建什么？',
  'Describe a task. Review changes. Let the agent handle the steps.': '描述任务，审核更改，让助手完成各个步骤。',
  'Create a Snake game': '创建贪吃蛇游戏', 'Explore this project': '了解这个项目',
  'Ready': '就绪', 'Action approval': '操作确认', 'Your approval is needed': '需要你的批准',
  'Preview diff': '预览差异', 'Approve': '批准', 'Reject': '拒绝', 'Task': '任务', 'Mode': '模式',
  'Agent': '代理', 'Chat': '聊天', 'Model': '模型', 'Loading models…': '正在加载模型…',
  'No models available': '没有可用模型', 'Send task': '发送任务', 'Stop': '停止',
  'Agent can inspect files and propose changes': '代理可以检查文件并提出更改',
  'Discuss without file changes': '仅讨论，不修改文件',
  'Ask the agent to build, fix, or explore…': '让助手构建、修复或探索…',
  'Ask a question about your project…': '询问有关项目的问题…',
  'Agent · Changes require approval · Shift+Enter for newline': '代理 · 更改需要批准 · Shift+Enter 换行',
  'Chat · No file changes · Shift+Enter for newline': '聊天 · 不修改文件 · Shift+Enter 换行',
  'Close task history': '关闭任务历史', 'Recent tasks in this workspace': '此工作区的最近任务',
  'Delete selected task': '删除所选任务', 'Connection settings': '连接设置', 'Close settings': '关闭设置',
  'Provider': '服务提供商', 'Local DeepLocal': '本地 DeepLocal', 'Remote OpenAI-compatible API': '远程 OpenAI 兼容 API',
  'Change': '更改', 'API key · Secure storage': 'API 密钥 · 安全存储', 'Set API key': '设置 API 密钥',
  'Clear key': '清除密钥', 'Update key': '更新密钥', 'API key configured': '已配置 API 密钥',
  'No API key configured': '尚未配置 API 密钥', 'Available models': '可用模型', 'Refresh models': '刷新模型',
  'Agent mode requires a model with tool calling. File changes and commands need approval. Deletions move individual files to the trash. Chat mode never edits files.': '代理模式需要支持工具调用的模型。文件更改和命令需要批准。删除会将单个文件移至回收站。聊天模式不会编辑文件。',
  'API protocol': 'API 协议', 'Reasoning summaries': '推理摘要', 'Request when supported': '请求摘要（需要模型支持）', 'Off': '关闭',
  'Responses requires a compatible endpoint and model. Chat Completions keeps progress updates without separate summaries.': 'Responses 需要兼容的接口和模型。Chat Completions 保留进度说明，但不提供独立推理摘要。',
  'Thinking…': '正在思考…', 'Starting…': '正在开始…', 'Stopping…': '正在停止…',
  'Waiting for your approval': '等待你的批准', 'Applying approved action…': '正在执行已批准的操作…',
  'Action declined': '操作已被拒绝', 'Task completed': '任务已完成', 'Needs attention': '需要处理',
  'Stopped · Applied changes kept': '已停止 · 已应用的更改已保留', 'No models · Check connection settings': '没有模型 · 请检查连接设置',
  'You': '你', 'DeepLocal': 'DeepLocal', 'Note': '提示', 'Progress update': '进度说明', 'Reasoning summary': '推理摘要',
  'Working': '执行中', 'Done': '完成', 'Failed': '失败', 'Declined': '已拒绝', 'Stopped': '已停止', 'Result': '结果',
  'Waiting for the tool result…': '等待工具结果…',
  'Create file': '创建文件', 'Write file': '写入文件', 'Modify file': '修改文件', 'Delete file': '删除文件',
  'Read file': '读取文件', 'Open file': '打开文件', 'Inspect workspace': '检查工作区', 'List files': '列出文件',
  'Search workspace': '搜索工作区', 'Inspect active editor': '检查当前编辑器', 'Read selection': '读取选中内容',
  'Check diagnostics': '检查诊断信息', 'Run command': '运行命令',
  'Task stopped. Already applied changes are retained.': '任务已停止。已应用的更改会保留。',
  'API key cannot be empty.': 'API 密钥不能为空。',
  'Remote API key stored securely.': '远程 API 密钥已安全保存。', 'Remote API key cleared.': '远程 API 密钥已清除。',
  'Open a project folder in VS Code before starting an agent task.': '启动代理任务前，请先在 VS Code 中打开项目文件夹。',
  'Code': '代码', 'Long response': '长回复',
};
