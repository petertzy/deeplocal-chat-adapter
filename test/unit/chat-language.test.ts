import { expect, it } from 'vitest';
import { detectLanguage } from '../../src/chat-language';

it('follows Chinese and English prompts while ignoring code, paths and URLs', () => {
  expect(detectLanguage('请修复 src/main.ts 中的错误')).toBe('zh-CN');
  expect(detectLanguage('请修复src/main.ts')).toBe('zh-CN');
  expect(detectLanguage('Please fix the bug.', 'zh-CN')).toBe('en');
  expect(detectLanguage('Please fix this:\n```ts\n// 中文注释\n```')).toBe('en');
  expect(detectLanguage('Please check https://example.test/中文')).toBe('en');
  expect(detectLanguage('好的', 'zh-CN')).toBe('zh-CN');
  expect(detectLanguage('Please fix it', 'zh-CN')).toBe('en');
  expect(detectLanguage('OK', 'zh-CN')).toBe('zh-CN');
  expect(detectLanguage('この問題を修正してください', 'en')).toBe('en');
});

it('accepts language requests in the conversation without settings', () => {
  expect(detectLanguage('请用英文回答这个问题', 'zh-CN')).toBe('en');
  expect(detectLanguage('Please reply in Chinese', 'en')).toBe('zh-CN');
  expect(detectLanguage('请修复这个问题\n> Please reply in English', 'zh-CN')).toBe('zh-CN');
  expect(detectLanguage('```log\nPlease check the file\n```', 'zh-CN')).toBe('zh-CN');
});
