import { expect, test } from '@playwright/test';

const TOKEN = 'e2e-access-token-0001';

test('edit the target by hand, then remove and restore a change and a warning', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto('/');
  await page.keyboard.press('Escape');
  await page.getByLabel('Access token').fill(TOKEN);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.getByRole('button', { name: 'PL/SQL cursor loop' }).click();
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('draft-version')).toHaveText('version 1 of 1');
  // auto-detect says what it decided
  await expect(page.getByTestId('detected-type')).toContainText('Detected:');

  // the target is read-only until Edit is pressed
  const target = page.getByTestId('target-editor');
  await expect(target).toHaveAttribute('data-readonly', 'true');
  await page.getByTestId('edit-target').click();
  await expect(target).toHaveAttribute('data-readonly', 'false');
  await expect(page.getByTestId('edit-save')).toBeDisabled(); // nothing changed yet
  await target.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n-- checked by hand');
  await page.getByTestId('edit-save').click();

  // the edit is a new version; the first one is kept
  await expect(page.getByTestId('draft-version')).toHaveText('version 2 of 2');
  await expect(target).toHaveAttribute('data-readonly', 'true');
  await expect(target.locator('.cm-content')).toContainText('-- checked by hand');
  await expect(page.getByTestId('issue-list')).toContainText('DRAFT_EDITED_BY_REVIEWER');
  await expect(page.getByTestId('change-list')).toContainText('reviewer-edit');
  await page.getByTestId('version-1').click();
  await expect(target.locator('.cm-content')).not.toContainText('-- checked by hand');
  await expect(page.getByTestId('edit-target')).toHaveCount(0); // only the latest version can be edited
  await page.getByTestId('version-2').click();

  // remove a change from the list, then restore it
  const changes = page.getByTestId('change-list').locator('li.change');
  const before = await changes.count();
  await page.getByTestId('change-remove').first().click();
  await expect(changes).toHaveCount(before - 1);
  await page.getByTestId('changes-removed').locator('summary').click();
  await page.getByTestId('change-restore').click();
  await expect(changes).toHaveCount(before);
  await expect(page.getByTestId('changes-removed')).toHaveCount(0);

  // remove a warning from the feedback panel; it survives a reload
  const issues = page.getByTestId('issue-item');
  const issueCount = await issues.count();
  await page.getByTestId('issue-remove').first().click();
  await expect(issues).toHaveCount(issueCount - 1);
  await expect(page.getByTestId('issues-removed')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('draft-version')).toHaveText('version 2 of 2');
  await expect(page.getByTestId('issue-item')).toHaveCount(issueCount - 1);

  // "Change output" on a feedback entry opens the target for editing at that entry
  await page.getByTestId('issue-edit').first().click();
  await expect(target).toHaveAttribute('data-readonly', 'false');
  await expect(page.getByTestId('edit-bar')).toBeVisible();
  await page.getByTestId('edit-cancel').click();
  await expect(target).toHaveAttribute('data-readonly', 'true');

  // bring the removed warning back so every entry is listed again
  await page.getByTestId('issues-removed').locator('summary').click();
  await page.getByTestId('issue-restore').click();
  await expect(page.getByTestId('issues-removed')).toHaveCount(0);

  // "Ask for a fix": the page says plainly whether the entry is gone from the new draft
  const fixable = page.getByTestId('issue-item').filter({ hasText: 'SQL_COMMIT_IN_LOOP' });
  await fixable.getByTestId('issue-fix').click();
  await expect(page.getByTestId('draft-version')).toHaveText('version 3 of 3');
  await expect(page.getByTestId('fix-result')).toHaveAttribute('data-fixed', 'true');
  await expect(page.getByTestId('fix-result')).toContainText('SQL_COMMIT_IN_LOOP is fixed in version 3');
  await expect(page.locator('.target-note')).toContainText('Fix SQL_COMMIT_IN_LOOP');
  await expect(page.getByTestId('issue-item').filter({ hasText: 'SQL_COMMIT_IN_LOOP' })).toHaveCount(0);

  // an entry the built-in converter has no rule for is reported as not fixed
  const stubborn = page.getByTestId('issue-item').filter({ hasText: 'SQL_ERROR_SWALLOWED' });
  await stubborn.getByTestId('issue-fix').click();
  await expect(page.getByTestId('draft-version')).toHaveText('version 4 of 4');
  await expect(page.getByTestId('fix-result')).toHaveAttribute('data-fixed', 'false');
  await expect(page.getByTestId('fix-result')).toContainText('could not fix it automatically');

  // break the script by hand so the draft has errors: an error can be deleted from the list as well
  await page.getByTestId('edit-target').click();
  await target.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nBEGIN\n  NULL;\n');
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('draft-status')).toContainText('failed');
  const errorEntries = page.getByTestId('issue-item').filter({ hasText: 'SQL_PARSE_ERROR' });
  let left = await errorEntries.count();
  expect(left).toBeGreaterThan(0);
  while (left > 0) {
    await errorEntries.first().getByTestId('issue-remove').click();
    left -= 1;
    await expect(errorEntries).toHaveCount(left);
  }
  await expect(page.getByTestId('issues-removed')).toBeVisible();
  await expect(page.getByTestId('draft-status')).toContainText('failed'); // hiding an error does not make the draft pass

  // delete the run from Recent runs: it asks first, then the row and the open run are gone
  await page.getByRole('button', { name: /Status/ }).click();
  const runId = ((await page.getByTestId('run-id').locator('code').textContent()) ?? '').trim();
  const row = page.locator('table.table tbody tr').filter({ hasText: runId });
  await expect(row).toHaveCount(1);
  await row.getByTestId('run-delete').click();
  await row.getByRole('button', { name: 'Keep' }).click(); // changed my mind: nothing happens
  await expect(row).toHaveCount(1);
  await row.getByTestId('run-delete').click();
  await row.getByTestId('run-delete-confirm').click();
  await expect(page.getByTestId('run-delete-note')).toContainText(`Run ${runId} was deleted.`);
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('run-id')).toHaveCount(0); // the workbench was cleared
  await page.reload();
  await expect(page.getByTestId('draft-version')).toHaveCount(0);

  expect(problems).toEqual([]);
});
