import {
  clearMockCalls,
  expect,
  getMockCalls,
  getMockState,
  showRightPanel,
  test,
} from './support/test'

const NEW_LAST_REFRESH = '2026-05-08 12:00:00'
const NEW_LAST_REFRESH_MS = 1778203200000

test.describe('refresh dedupe', () => {
  test('after a manual refresh the next set_list carries the new last_refresh timestamp', async ({
    page,
  }) => {
    // Regression for "刷新成功后还会再次刷新": a manual refresh only emits
    // hosts_refreshed (no reload_list), so the renderer must merge the
    // refreshed node back into the main tree. Otherwise the next full save
    // (set_list from a toggle / edit / reorder) pushes the stale
    // last_refresh_ms back to disk, re-dueing the node in the scanner.
    await clearMockCalls(page)

    await page.locator('[data-id="remote-blocklist"]').click()
    await showRightPanel(page)
    await page.getByRole('button', { name: 'Refresh' }).click()

    // The mock emits hosts_refreshed; wait until the renderer consumed it
    // and updated the selected node's timestamp.
    await expect
      .poll(async () => {
        const state = await getMockState(page)
        return state.list.find((item) => item.id === 'remote-blocklist')?.last_refresh
      })
      .toBe(NEW_LAST_REFRESH)

    // Allow the hosts_refreshed handler to land in the main tree store.
    await page.waitForTimeout(300)

    // Any set_list-triggering user action (here: toggling the scheme on)
    // must now carry the NEW last_refresh_ms in the full list payload.
    const row = page.locator('[data-id="remote-blocklist"]')
    await row.getByRole('switch').click()
    await expect
      .poll(async () => {
        const calls = await getMockCalls(page)
        const setListCall = calls.find((call) => call.cmd === 'set_list')
        const list = setListCall?.args?.args?.[0] as Array<Record<string, unknown>> | undefined
        const node = list?.find((item) => item.id === 'remote-blocklist')
        return {
          lastRefresh: node?.last_refresh,
          lastRefreshMs: node?.last_refresh_ms,
        }
      })
      .toEqual({
        lastRefresh: NEW_LAST_REFRESH,
        lastRefreshMs: NEW_LAST_REFRESH_MS,
      })
  })
})