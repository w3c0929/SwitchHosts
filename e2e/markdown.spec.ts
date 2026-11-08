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
    await expect(page.getByTestId('md-view-toggle').getByText('Preview', { exact: true })).toBeVisible()
    await expect(page.getByTestId('md-view-toggle').getByText('Edit', { exact: true })).toBeVisible()
    // Default preview → the raw editor stays hidden.
    await expect(page.locator('.cm-content')).not.toBeVisible()

    // Switch to source and write Markdown.
    await page.getByTestId('md-view-toggle').getByText('Edit', { exact: true }).click()
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
    await page.getByTestId('md-view-toggle').getByText('Preview', { exact: true }).click()
    await expect(page.locator('.cm-content')).not.toBeVisible()
    const preview = page.getByTestId('markdown-preview')
    await expect(preview.locator('h1')).toContainText('Hello MD')
    await expect(preview.locator('strong')).toContainText('bold')

    // Non-Markdown entries keep the plain hosts editor and hide the switch.
    await page.locator('[data-id="local-api"]').click()
    await expect(page.getByTestId('md-view-toggle').getByText('Edit', { exact: true })).toHaveCount(0)
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
    await page.getByTestId('md-view-toggle').getByText('Edit', { exact: true }).click()
    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.type('# Second')
    await page.waitForTimeout(1400)

    await page.getByTestId('md-view-toggle').getByText('Preview', { exact: true }).click()
    await expect(page.getByTestId('markdown-preview').locator('h1')).toContainText('Second')

    await page.getByTestId('md-view-toggle').getByText('Edit', { exact: true }).click()
    await expect(editor).toBeVisible()
    // Editable after the round trip.
    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' ok')
    await expect(editor).toContainText('ok')
  })

  test('allows selecting text in the markdown preview', async ({ page }) => {
    // 全局样式默认 user-select:none；预览区必须显式恢复，否则无法拖选复制。
    await page.getByLabel('Add').click()
    const drawer = page.getByRole('dialog')
    await drawer.getByLabel('Hosts Title', { exact: true }).fill('select.md')
    await drawer.getByRole('button', { name: 'OK' }).click()

    const row = page.locator('[data-id]').filter({ hasText: 'select.md' })
    await row.click()

    await page.getByTestId('md-view-toggle').getByText('Edit', { exact: true }).click()
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type('# Select me')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('selectable paragraph text')
    await page.waitForTimeout(1400)

    await page.getByTestId('md-view-toggle').getByText('Preview', { exact: true }).click()
    const preview = page.getByTestId('markdown-preview')
    const paragraph = preview.locator('p').filter({ hasText: 'selectable paragraph text' })
    await expect(paragraph).toBeVisible()

    const userSelect = await preview.evaluate((el) => getComputedStyle(el).userSelect)
    expect(userSelect).toBe('text')

    // Drag-select the paragraph with the mouse.
    const box = (await paragraph.boundingBox())!
    await page.mouse.move(box.x + 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()

    const selected = await page.evaluate(() => window.getSelection()?.toString() || '')
    expect(selected).toContain('selectable paragraph')
  })

  test('split mode edits with a live preview', async ({ page }) => {
    await page.getByLabel('Add').click()
    const drawer = page.getByRole('dialog')
    await drawer.getByLabel('Hosts Title', { exact: true }).fill('split.md')
    await drawer.getByRole('button', { name: 'OK' }).click()

    await page.locator('[data-id]').filter({ hasText: 'split.md' }).click()
    await page.getByTestId('md-view-toggle').getByText('Split', { exact: true }).click()

    const editor = page.locator('.cm-content')
    const preview = page.getByTestId('markdown-preview')
    await expect(editor).toBeVisible()
    await expect(preview).toBeVisible()
    await expect(page.getByTestId('md-split-divider')).toBeVisible()

    // Typing updates the preview immediately (no mode switch needed).
    await editor.click()
    await page.keyboard.type('# Live title')
    await expect(preview.locator('h1')).toContainText('Live title')
  })

  test('split layout follows the preference and scrolls in sync', async ({ page }) => {
    await page.getByLabel('Add').click()
    const drawer = page.getByRole('dialog')
    await drawer.getByLabel('Hosts Title', { exact: true }).fill('long.md')
    await drawer.getByRole('button', { name: 'OK' }).click()

    const row = page.locator('[data-id]').filter({ hasText: 'long.md' })
    await row.click()

    // Give the document enough content to scroll on both sides.
    const mdId = await page.evaluate(() => {
      const st = window.__SWITCHHOSTS_E2E__.state
      const entry = st.list.find((item) => item.title === 'long.md')!
      st.contents[entry.id] = Array.from(
        { length: 120 },
        (_, i) => `## Section ${i}\n\nparagraph ${i} with some text to render.`,
      ).join('\n\n')
      return entry.id
    })
    // Reselect to reload the document from the store.
    await page.locator('[data-id="local-api"]').click()
    await page.locator(`[data-id="${mdId}"]`).click()

    await page.getByTestId('md-view-toggle').getByText('Split', { exact: true }).click()
    const editor = page.getByTestId('md-split-editor')
    const preview = page.getByTestId('md-split-preview')
    await expect(editor).toBeVisible()
    await expect(preview).toBeVisible()

    // Default layout: preview left, editor right.
    const editorBox = (await editor.boundingBox())!
    const previewBox = (await preview.boundingBox())!
    expect(previewBox.x).toBeLessThan(editorBox.x)

    // Enable "editor on the left" → order flips immediately.
    await page.getByLabel('Settings').click()
    await page.getByText('Preferences').click()
    const preferences = page.getByRole('dialog')
    await preferences.getByLabel('Editor on the left in split view').check()
    await page.keyboard.press('Escape')
    await expect(preferences).not.toBeVisible()

    const editorBox2 = (await editor.boundingBox())!
    const previewBox2 = (await preview.boundingBox())!
    expect(editorBox2.x).toBeLessThan(previewBox2.x)

    // Sync scrolling: scrolling the editor scrolls the preview.
    const previewScroller = preview.getByTestId('markdown-preview')
    await editor.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2)
    })
    await expect
      .poll(async () => previewScroller.evaluate((el) => el.scrollTop), { timeout: 4000 })
      .toBeGreaterThan(0)
  })

  test('copies code block content from the preview', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

    await page.getByLabel('Add').click()
    const drawer = page.getByRole('dialog')
    await drawer.getByLabel('Hosts Title', { exact: true }).fill('code.md')
    await drawer.getByRole('button', { name: 'OK' }).click()

    await page.locator('[data-id]').filter({ hasText: 'code.md' }).click()
    await page.getByTestId('md-view-toggle').getByText('Edit', { exact: true }).click()
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type('```yaml')
    await page.keyboard.press('Enter')
    await page.keyboard.type('name: demo')
    await page.keyboard.press('Enter')
    await page.keyboard.type('```')

    await page.getByTestId('md-view-toggle').getByText('Preview', { exact: true }).click()
    const block = page.getByTestId('code-block')
    await expect(block).toBeVisible()
    await expect(block.locator('span').first()).toContainText('yaml')

    await block.getByTestId('code-copy-button').click()
    await expect(block.getByTestId('code-copy-button')).toContainText('Copied')

    const text = await page.evaluate(() => navigator.clipboard.readText())
    expect(text).toContain('name: demo')
  })
})
