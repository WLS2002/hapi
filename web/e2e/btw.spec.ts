import { expect, test } from '@playwright/test'

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`BTW create, send, hide and end at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await page.addInitScript(() => localStorage.setItem('hapi-lang', 'en'))
        await page.goto('/e2e-fixtures/btw-fixture.html')
        await page.getByRole('button', { name: 'BTW', exact: true }).click()
        await page.getByRole('button', { name: 'New BTW' }).click()
        const panel = page.getByRole('region', { name: 'BTW', exact: true })
        await expect(panel.getByText('BTW inherits the current context.', { exact: false })).toBeVisible()
        // Existing FUE hints are unrelated to BTW; dismiss through their visible action.
        for (let index = 0; index < 4; index++) {
            const hint = page.getByRole('button', { name: 'Got it', exact: true })
            if (!await hint.count()) break
            await hint.last().click()
        }
        const input = panel.getByRole('textbox').first()
        await input.fill('Explain the inherited context')
        await input.press('Enter')
        await expect(panel.getByText('Side answer to: Explain the inherited context')).toBeVisible()
        await input.fill('Keep this draft')
        await panel.getByRole('button', { name: 'Back to main conversation' }).click()
        await expect(page.locator('[data-session-chat="main"]')).toBeVisible()
        await page.getByRole('button', { name: 'BTW', exact: true }).click()
        await expect.poll(() => panel.getByRole('textbox').first().evaluate(element => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element.value : element.textContent)).toBe('Keep this draft')
        await expect(page.locator('[data-session-chat="main"]')).toBeVisible({ visible: viewport.width >= 1024 })
        const size = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }))
        expect(size.scroll).toBeLessThanOrEqual(size.viewport)
        await panel.getByRole('button', { name: 'End BTW', exact: true }).click()
        await page.getByRole('dialog').getByRole('button', { name: 'End BTW', exact: true }).click()
        await expect(panel.getByText('BTW ended · history is available').first()).toBeVisible()
        await expect(panel.locator('textarea, [role="textbox"]').first()).not.toBeEditable()
        const calls = await page.evaluate(() => (window as unknown as { __btwCalls: Array<{ method: string; id: string }> }).__btwCalls)
        expect(calls.filter(call => call.method === 'send')).toEqual([expect.objectContaining({ id: 'side-1' })])
        expect(calls.filter(call => call.method === 'end')).toEqual([{ method: 'end', id: 'side-1' }])
    })
}
