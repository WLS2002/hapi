import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
    ...base,
    testMatch: 'btw.spec.ts',
    use: { ...base.use, baseURL: 'http://127.0.0.1:5174' },
    webServer: {
        command: 'bun run dev --host 127.0.0.1 --port 5174',
        url: 'http://127.0.0.1:5174',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
})
