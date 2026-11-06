import { afterEach, expect, it } from 'vitest'
import { isShortcutForSession } from './chatShortcutScope'
afterEach(() => { document.body.innerHTML = '' })
it('targets shortcuts only at the focused chat when main and BTW coexist', () => {
    document.body.innerHTML = '<div data-session-chat="main"><textarea id="main"></textarea></div><div data-session-chat="side"><textarea id="side"></textarea></div>'
    expect(isShortcutForSession(document.querySelector('#side'), 'main')).toBe(false)
    expect(isShortcutForSession(document.querySelector('#side'), 'side')).toBe(true)
    expect(isShortcutForSession(document.body, 'main')).toBe(false)
})
it('preserves page shortcuts when only one chat is mounted', () => {
    document.body.innerHTML = '<div data-session-chat="main"></div>'
    expect(isShortcutForSession(document.body, 'main')).toBe(true)
})
