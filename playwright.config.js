import { defineConfig } from '@playwright/test'

export default defineConfig({
  timeout: 60000,
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 3,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'off' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 4173', url: 'http://127.0.0.1:4173', reuseExistingServer: false },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { viewport: { width: 768, height: 1024 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
})
