import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const TOKEN = 'e2e-access-token-0001';
// The fixture converts cleanly, so one command without a Python mapping is added to get a warning with a line number.
const SOURCE = readFileSync(join(process.cwd(), 'evals/fixtures/mixed-ssh-scp-password.sh'), 'utf8').replace(/exit 0\s*$/, 'lpstat -t\nexit 0\n');

test('convert, review, request changes, approve with a failed save and retry, rate, reload', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });

  // the hook is skippable and lands on the headline
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Skip/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('hook')).toHaveAttribute('data-state', 'done');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('19c and shell in. Upgrade-safe SQL and Python out.');

  // the access token gate
  await page.getByLabel('Access token').fill(TOKEN);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByTestId('convert')).toBeDisabled();

  // paste and convert
  await page.getByTestId('source-editor').locator('.cm-content').fill(SOURCE);
  await page.getByLabel('Generate config file').check();
  await page.getByTestId('convert').click();

  await expect(page.getByTestId('target-label')).toHaveText('Draft');
  await expect(page.getByTestId('draft-version')).toHaveText('version 1 of 1');
  await expect(page.getByTestId('draft-status')).toContainText('ok with warnings');
  const track = page.getByTestId('stage-track');
  for (const stage of ['intake', 'generate', 'validate', 'review', 'results']) await expect(track.locator(`[data-stage="${stage}"]`)).toHaveAttribute('data-status', 'done');
  await expect(track.locator('[data-stage="repair"]')).toHaveAttribute('data-status', /done|skipped/);
  await expect(page.getByTestId('stage-live')).toContainText('Draft version 1 is ready');

  // the source editor now shows the sanitized text, never the raw input
  const sourceText = page.getByTestId('source-editor').locator('.cm-content');
  await expect(sourceText).toContainText('${DB_PASSWORD}');
  await expect(sourceText).not.toContainText('Summ3r#Payroll');
  await expect(sourceText).not.toContainText('northwind-hr.com');
  await expect(page.getByTestId('source-note')).toContainText('sanitized source');
  await expect(page.getByTestId('sanitization-summary')).toContainText('replaced');
  await expect(page.getByTestId('file-target.py')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('file-config.ini.template')).toBeVisible();
  await expect(page.getByTestId('change-list').locator('li').first()).toBeVisible();

  // diff toggle
  const diff = page.getByTestId('diff-toggle');
  await expect(diff).toHaveAttribute('aria-pressed', 'false');
  await diff.click();
  await expect(diff).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('diff-view').locator('.cm-mergeView')).toBeVisible();
  await diff.click();
  await expect(page.getByTestId('diff-view')).toHaveCount(0);

  // an issue entry jumps to its line in the target editor
  const issue = page.getByTestId('issue-item').first();
  await expect(issue).toContainText('SHELL_UNMAPPED_COMMAND');
  await expect(issue).toContainText('Next step');
  await issue.getByTestId('issue-jump').click();
  await expect(page.getByTestId('target-editor').locator('.cm-jumpLine')).toBeVisible();
  await expect(page.getByTestId('target-editor').locator('.cm-jumpLine')).toContainText('lpstat');

  // request changes -> draft version 2
  await page.getByTestId('request-changes').click();
  await page.getByLabel('What should change in the next draft?').fill('Keep every exit code and add a short comment above the transfer step.');
  await page.getByTestId('revise-submit').click();
  await expect(page.getByTestId('draft-version')).toHaveText('version 2 of 2');
  await expect(page.getByTestId('target-label')).toHaveText('Draft');
  await expect(page.getByTestId('version-1')).toBeVisible();

  // approve: the first save fails (simulated), Retry succeeds
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('save-failed')).toContainText('simulated save failure');
  await page.getByTestId('retry-save').click();
  await expect(page.getByTestId('final-banner')).toBeVisible();
  await expect(page.getByTestId('save-failed')).toHaveCount(0);
  await expect(page.getByTestId('target-label')).toHaveText('Final');
  await expect(page.getByTestId('commit-link')).toHaveText(/^[0-9a-f]{7}/);
  await expect(page.getByTestId('commit-ref')).toContainText('conversions/');
  await expect(page.getByTestId('copy')).toBeVisible();
  await expect(page.getByTestId('download')).toBeVisible();

  // rating
  await page.getByTestId('rate-5').click();
  await expect(page.getByTestId('rate-5')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('rating-comment').fill('Clear change list, nothing to fix by hand.');
  await page.getByRole('button', { name: 'Send rating' }).click();
  await expect(page.getByTestId('rating-confirmation')).toContainText('5 out of 5');

  // a reload restores the run from the server
  await page.reload();
  await expect(page.getByTestId('final-banner')).toBeVisible();
  await expect(page.getByTestId('target-label')).toHaveText('Final');
  await expect(page.getByTestId('draft-version')).toHaveText('version 2 of 2');
  await expect(page.getByTestId('rating-confirmation')).toBeVisible();
  await expect(page.getByTestId('hook')).toHaveAttribute('data-state', 'done');

  // status view
  await page.getByTestId('status-toggle').click();
  await expect(page.getByTestId('status-panel')).toContainText('GitHub save failures');

  expect(problems).toEqual([]);
});
