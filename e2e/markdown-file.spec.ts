import { clearMockCalls, expect, getMockCalls, getMockState, test } from './support/test'

const MD_PATH = 'C:\\e2e\\notes.md'

test.describe('local markdown file entries', () => {
  test('picking a local .md file adds a list entry, previews it and saves edits back to the file', async ({
    page,
  }) => {
    await page.evaluate((path) => {
      window.__SWITCHHOSTS_E2E__.state.mdFiles[path] = '# Notes from file\n\nhello\n'
    }, MD_PATH)
    await clearMockCalls(page)

    // Add form → "Open local Markdown document" → Browse.
    await page.getByLabel('Add').click()
    const drawer = page.getByRole('dialog')
    await expect(drawer.getByText('Open local Markdown document')).toBeVisible()
    await drawer.getByRole('button', { name: /Browse/ }).click()

    // The drawer closes and the file appears as its own entry, opened.
    await expect(drawer).not.toBeVisible()
    const row = page.locator('[data-id]').filter({ hasText: 'notes.md' })
    await expect(row).toHaveCount(1)
    await expect(row).toBeVisible()

    // Default preview renders the file content; the editor stays hidden.
    const preview = page.getByTestId('markdown-preview')
    await expect(preview.locator('h1')).toContainText('Notes from file')
    await expect(page.locator('.cm-content')).not.toBeVisible()

    // The toggle is now Preview | Edit.
    await expect(page.getByTestId('md-view-toggle').getByText('Preview', { exact: true })).toBeVisible()
    await expect(page.getByTestId('md-view-toggle').getByText('Edit', { exact: true })).toBeVisible()

    // Edit → change the content.
    await page.getByTestId('md-view-toggle').getByText('Edit', { exact: true }).click()
    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('**added in app**')

    // Debounced save writes back to the original file.
    await expect
      .poll(
        async () => {
          const calls = await getMockCalls(page)
          return calls.some(
            (call) =>
              call.cmd === 'write_md_file' &&
              String(call.args?.args?.[0]) === MD_PATH &&
              String(call.args?.args?.[1]).includes('**added in app**'),
          )
        },
        { timeout: 5000 },
      )
      .toBe(true)

    const state = await getMockState(page)
    expect(state.mdFiles[MD_PATH]).toContain('**added in app**')
    // The entry carries the file path and never reaches the hosts pipeline.
    const entry = state.list.find((item) => item.md_path === MD_PATH)
    expect(entry?.as_hosts).toBe(false)
    expect(entry?.title).toBe('notes.md')

    // Back to preview → rendered update.
    await page.getByTestId('md-view-toggle').getByText('Preview', { exact: true }).click()
    await expect(preview.locator('strong')).toContainText('added in app')

    // Re-selecting the entry reloads from disk (read_md_file called again).
    await page.locator('[data-id="local-api"]').click()
    await page.waitForTimeout(100)
    const readsBefore = (await getMockCalls(page)).filter(
      (call) => call.cmd === 'read_md_file',
    ).length
    await row.click()
    await expect
      .poll(async () => {
        const calls = await getMockCalls(page)
        return calls.filter((call) => call.cmd === 'read_md_file').length
      })
      .toBeGreaterThan(readsBefore)

    // Picking the same file again reuses the existing entry (no duplicate).
    await page.getByLabel('Add').click()
    const drawer2 = page.getByRole('dialog')
    await drawer2.getByRole('button', { name: /Browse/ }).click()
    await expect(page.locator('[data-id]').filter({ hasText: 'notes.md' })).toHaveCount(1)
  })
})
