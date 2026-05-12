import { defineConfig } from '@playwright/test';

(globalThis as any).__DEBUG__ = false;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
});
