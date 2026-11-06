import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { BtwPanel } from './BtwPanel'

afterEach(() => { cleanup(); localStorage.clear() })

it('creates a BTW in the parent and hides without ending it', async () => {
    const createBtw = vi.fn(async () => ({ sessionId: 'new-side' }))
    const archiveSession = vi.fn()
    const close = vi.fn()
    render(<I18nProvider><BtwPanel api={{ createBtw, archiveSession } as unknown as ApiClient}
        parent={{ id: 'main', active: true, metadata: { capabilities: { btw: true } } } as Session}
        onClose={close} onCreated={() => {}} renderConversation={id => <p>Chat {id}</p>} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'New BTW' }))
    await screen.findByText('Chat new-side')
    expect(createBtw).toHaveBeenCalledWith('main')
    fireEvent.click(screen.getByRole('button', { name: 'Back to main conversation' }))
    expect(close).toHaveBeenCalledOnce()
    expect(archiveSession).not.toHaveBeenCalled()
})

it('switches existing BTW conversations and keeps selection on reopen', async () => {
    const parent = { id: 'main', active: true, metadata: { capabilities: { btw: true }, codexSideThreads: [
        { sessionId: 'side-a', threadId: 'a' }, { sessionId: 'side-b', threadId: 'b' }
    ] } } as Session
    const content = () => <I18nProvider><BtwPanel api={{} as ApiClient} parent={parent}
        onClose={() => {}} onCreated={() => {}} renderConversation={id => <p>Chat {id}</p>} /></I18nProvider>
    const view = render(content())
    fireEvent.change(screen.getByRole('combobox', { name: 'BTW conversations' }), { target: { value: 'side-b' } })
    expect(screen.getByText('Chat side-b')).toBeTruthy()
    view.unmount(); render(content())
    await waitFor(() => expect(screen.getByText('Chat side-b')).toBeTruthy())
})
