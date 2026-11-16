import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

for (const mobile of [false, true]) {
    test(`exports and imports browser settings (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
        await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 })
        await page.addInitScript(() => {
            if (!localStorage.getItem('hapi-lang')) {
                localStorage.setItem('hapi-lang', 'en')
                localStorage.setItem('hapi-appearance', 'dark')
                localStorage.setItem('hapi_access_token::https://hub.test', 'private-token')
                localStorage.setItem('hapi.btw.selected.session', 'side-session')
            }
        })
        await page.goto('/e2e-fixtures/settings-fixture.html?page=about')
        const downloadEvent = page.waitForEvent('download')
        await page.getByRole('button', { name: 'Export', exact: true }).click()
        const download = await downloadEvent
        const path = testInfo.outputPath('settings.json')
        await download.saveAs(path)
        const file = JSON.parse(await readFile(path, 'utf8'))
        expect(file).toMatchObject({ format: 'hapi-web-settings', version: 1, settings: { 'hapi-appearance': 'dark' } })
        expect(JSON.stringify(file)).not.toContain('private-token')
        expect(JSON.stringify(file)).not.toContain('side-session')
        const input = page.locator('input[type="file"]')
        await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
        await expect(page.getByRole('alert')).toHaveText('This file is not a HAPI settings export.')
        expect(await page.evaluate(() => localStorage.getItem('hapi-appearance'))).toBe('dark')
        const reload = page.waitForEvent('load')
        await input.setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
            ...file, settings: { ...file.settings, 'hapi-appearance': 'light' },
        })) })
        await reload
        await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible()
        expect(await page.evaluate(() => localStorage.getItem('hapi-appearance'))).toBe('light')
        expect(await page.evaluate(() => localStorage.getItem('hapi_access_token::https://hub.test'))).toBe('private-token')
        expect(await page.evaluate(() => localStorage.getItem('hapi.btw.selected.session'))).toBe('side-session')
        await page.screenshot({ path: testInfo.outputPath('settings-transfer.png'), fullPage: true })
    })
}
