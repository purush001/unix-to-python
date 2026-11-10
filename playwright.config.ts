import { existsSync } from 'node:fs';
import { chromium, defineConfig, devices } from '@playwright/test';

const PORT = 3210;
// Use the bundled browser when it is installed; otherwise the preinstalled one.
const fallback = '/opt/pw-browsers/chromium';
const executablePath = existsSync(chromium.executablePath()) || !existsSync(fallback) ? undefined : fallback;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } } }],
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    // mock providers only; the mock GitHub fails the first save so the Retry path is exercised
    env: { APP_ACCESS_TOKEN: 'e2e-access-token-0001', MOCK_GITHUB_FAILURES: '1' },
  },
});
