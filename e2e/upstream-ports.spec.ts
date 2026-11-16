import type { Page } from '@playwright/test'
import {
  clearMockCalls,
  expect,
  getMockCalls,
  getMockState,
  selectAllModifier,
  test,
} from './support/test'

/** 文本坐标（含高亮 span），用于模拟 Alt 拖选。 */
async function textPoint(page: Page, line: number, column: number) {
  return page
    .locator('.cm-content .cm-line')
    .nth(line)
    .evaluate((element, offset) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const length = node.textContent?.length ?? 0
        if (offset <= length) {
          const range = document.createRange()
          range.setStart(node, offset)
          range.collapse(true)
          const rect = range.getBoundingClientRect()
          return { x: rect.x, y: rect.y + rect.height / 2 }
        }
        offset -= length
        node = walker.nextNode()
      }
      throw new Error('Text position not found')
    }, column)
}

async function setEditorContent(page: Page, content: string) {
  await page.locator('[data-id="local-dev"]').click()
  const editor = page.locator('.cm-content')
  await expect(editor).toContainText('dev.local')
  await editor.click()
  await page.keyboard.press(`${selectAllModifier}+A`)
  await page.keyboard.insertText(content)
  await expect
    .poll(async () => (await getMockState(page)).contents['local-dev'])
    .toBe(content)
}

test.describe('upstream ports', () => {
  test('suppresses the web context menu on the list background', async ({ page }) => {
    await clearMockCalls(page)

    const prevented = await page.getByTestId('left-panel').evaluate((panel) => {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
      })
      panel.dispatchEvent(event)
      return event.defaultPrevented
    })

    expect(prevented).toBe(true)
    const menus = (await getMockCalls(page)).filter((call) => call.cmd === 'popup_menu')
    expect(menus).toHaveLength(1)
  })

  test('opens a URL from a comment with Ctrl/Cmd + click', async ({ page }) => {
    const url = 'https://example.test/list'
    await setEditorContent(page, `127.0.0.1 a.local # source ${url}`)
    await clearMockCalls(page)

    const link = page.locator('.hl-comment-link')
    await expect(link).toHaveText(url)

    await page.keyboard.down(selectAllModifier)
    await link.click()
    await page.keyboard.up(selectAllModifier)

    await expect
      .poll(async () => {
        const calls = await getMockCalls(page)
        return calls
          .filter((call) => call.cmd === 'open_url')
          .map((call) => call.args?.args?.[0])
      })
      .toContain(url)

    // 普通点击不打开链接（不影响光标与选择）。
    await clearMockCalls(page)
    await link.click()
    const after = await getMockCalls(page)
    expect(after.some((call) => call.cmd === 'open_url')).toBe(false)
  })

  test('selects a column with Alt + drag and edits every line at once', async ({ page }) => {
    await setEditorContent(
      page,
      ['0.0.0.0 alpha.local', '0.0.0.0 bravo.local', '0.0.0.0 charlie.local'].join('\n'),
    )
    await page.locator('.cm-content').click({ trial: true })

    const start = await textPoint(page, 0, 0)
    const end = await textPoint(page, 2, 9)
    await page.keyboard.down('Alt')
    await page.mouse.move(start.x, start.y)
    await expect(page.locator('.cm-content')).toHaveCSS('cursor', 'crosshair')
    await page.mouse.down()
    // -2px：落在第 9 列的字符内部，避免边界取到下一列。
    await page.mouse.move(end.x - 2, end.y, { steps: 10 })
    await page.mouse.up()
    await page.keyboard.up('Alt')

    // 三行各有一个选区，行 2/3 带次光标。
    await expect(page.locator('.cm-selectionBackground')).toHaveCount(3)
    await expect(page.locator('.cm-cursor-secondary')).toHaveCount(2)

    // 三行的 IP 列同时被选中，插入一次即可整体替换（type 会逐键操作，
    // 只有 insertText 才按多选区一次性替换）。像素取列的边界可能差
    // 一个字符，所以断言"三行都被替换"，不锁定尾随空格。
    await page.keyboard.insertText('127.0.0.1')
    const lines = page.locator('.cm-content .cm-line')
    await expect(lines).toHaveCount(3)
    for (let i = 0; i < 3; i++) {
      await expect(lines.nth(i)).toContainText('127.0.0.1')
    }
    await expect(lines.nth(1)).not.toContainText('0.0.0.0')
    await expect(lines.nth(2)).not.toContainText('0.0.0.0')
  })
})
