import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/webview',
  use: {
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    viewport: { width: 340, height: 820 },
    screenshot: 'only-on-failure',
  },
});
