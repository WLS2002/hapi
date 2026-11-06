/** Global chat shortcuts must not control the other composer in split view. */
export function isShortcutForSession(target: EventTarget | null, sessionId: string): boolean {
    const owner = target instanceof Element ? target.closest('[data-session-chat]') : null
    if (owner) return owner.getAttribute('data-session-chat') === sessionId
    return document.querySelectorAll('[data-session-chat]').length <= 1
}
