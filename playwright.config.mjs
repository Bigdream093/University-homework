import { defineConfig } from '@playwright/test'

// External targets must be disposable local instances; tests create users and submissions.
const external = process.env.BROWSER_TEST_BASE_URL
const target = external ? 'release' : 'source'
if (external && !['127.0.0.1', 'localhost'].includes(new URL(external).hostname))
  throw new Error('Browser tests only support isolated local servers')
export default defineConfig({
  testDir: './test/browser',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  outputDir: `test-results/browser-${target}`,
  reporter: [['list'], ['html', { outputFolder: `test-results/browser-${target}-report`, open: 'never' }]],
  use: {
    actionTimeout: 15_000,
    baseURL: external || 'http://127.0.0.1:39061',
    browserName: 'chromium',
    channel: 'chromium',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: external ? undefined : {
    command: 'node test/browser/start-server.mjs',
    url: 'http://127.0.0.1:39061',
    reuseExistingServer: false,
  },
})
