import { clearMockCalls, expect, getMockCalls, getMockState, test } from './support/test'

test.describe('markdown entries', () => {
  test('adds a .md entry, previews by default, edits in source and remembers the mode', async ({
    page,
  }) => {
    await clearMockCalls(page)

    // Add a local entry whose title ends in .md → treated as Markdown.
    await page.getByLabel('Add').click()
    const drawer = page.getByRole('dialog')
    await expect(drawer.getByText('Add Hosts Entry')).toBeVisible()
    await drawer.getByLabel('Hosts Title', { exact: true }).fill('readme.md')
    await drawer.getByRole('button', { name: 'OK' }).click()

    const row = page.locator('[data-id]').filter({ hasText: 'readme.md' })
    await expect(row).toBeVisible()
    await row.click()

    // Markdown entries are forced out of the system hosts pipeline.
    await expect
      .poll(async () => {
        const state = await getMockState(page)
        return state.list.find((item) => item.title === 'readme.md')?.as_hosts
      })
      .toBe(false)

    // Top bar gains the Preview / Source Code switch, defaulting to preview.
    await expect(page.getByText('Preview', { exact: true })).toBeVisible()
    await expect(page.getByText('Source Code', { exact: true })).toBeVisible()
    // Default preview → the raw editor stays hidden.
    await expect(page.locator('.cm-content')).not.toBeVisible()

    // Switch to source and write Markdown.
    await page.getByText('Source Code', { exact: true }).click()
    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.type('# Hello MD')
    await page.keyboard.press('Enter')
    await page.keyboard.type('**bold** text')

    // Debounced save (1s) → config_update records the remembered mode.
    await page.waitForTimeout(1400)
    await expect
      .poll(async () => {
        const calls = await getMockCalls(page)
        return calls.some(
          (call) =>
            call.cmd === 'config_update' &&
            (call.args?.args?.[0] as Record<string, unknown> | undefined)?.md_view_mode ===
              'source',
        )
      })
      .toBe(true)

    // Back to preview → rendered Markdown (heading + emphasis), editor hidden.
    await page.getByText('Preview', { exact: true }).click()
    await expect(page.locator('.cm-content')).not.toBeVisible()
    const preview = page.getByTestId('markdown-preview')
    await expect(preview.locator('h1')).toContainText('Hello MD')
    await expect(preview.locator('strong')).toContainText('bold')

    // Non-Markdown entries keep the plain hosts editor and hide the switch.
    await page.locator('[data-id="local-api"]').click()
    await expect(page.getByText('Source Code', { exact: true })).toHaveCount(0)
    await expect(page.locator('.cm-content')).toBeVisible()
  })

  test('remeasures the editor after switching preview → source', async ({ page }) => {
    // Regression guard: the CodeMirror view stays mounted but hidden behind
    // the preview; switching back must restore a measured, editable surface.
    await page.getByLabel('Add').click()
    const drawer = page.getByRole('dialog')
    await drawer.getByLabel('Hosts Title', { exact: true }).fill('second.md')
    await drawer.getByRole('button', { name: 'OK' }).click()

    const row = page.locator('[data-id]').filter({ hasText: 'second.md' })
    await row.click()

    // The previous test finished in source mode, but tests run in isolation:
    // start from whatever mode is current, then force source via the control.
    await page.getByText('Source Code', { exact: true }).click()
    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.type('# Second')
    await page.waitForTimeout(1400)

    await page.getByText('Preview', { exact: true }).click()
    await expect(page.getByTestId('markdown-preview').locator('h1')).toContainText('Second')

    await page.getByText('Source Code', { exact: true }).click()
    await expect(editor).toBeVisible()
    // Editable after the round trip.
    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' ok')
    await expect(editor).toContainText('ok')
  })
})
