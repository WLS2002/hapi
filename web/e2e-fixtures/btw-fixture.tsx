import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRoute, createRouter, RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { SessionChat } from '../src/components/SessionChat'
import { I18nProvider } from '../src/lib/i18n-context'
import { AppContextProvider } from '../src/lib/app-context'
import { ToastProvider } from '../src/lib/toast-context'
import { VoiceProvider } from '../src/lib/voice-context'
import { PwaUpdateProvider } from '../src/lib/pwa-update-context'
import { queryKeys } from '../src/lib/query-keys'
import { ingestIncomingMessages } from '../src/lib/message-window-store'
import type { ApiClient } from '../src/api/client'
import type { Session, DecryptedMessage } from '../src/types/api'
import '../src/index.css'

const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
const now = Date.now()
const base: Session = { id: 'main', namespace: 'default', seq: 0, createdAt: now, updatedAt: now, active: true, activeAt: now,
    metadataVersion: 1, agentStateVersion: 1, agentState: { controlledByUser: false }, thinking: true, thinkingAt: now,
    model: 'gpt-6.1-sol', modelReasoningEffort: 'high', permissionMode: 'read-only',
    metadata: { path: '/fixture/hapi', host: 'Mac mini', flavor: 'codex', name: 'Build a better Hapi', capabilities: { concurrentClients: true, btw: true } } } as Session
const sessions = new Map<string, Session>([['main', base]])
const transcript = new Map<string, DecryptedMessage[]>()
const calls: Array<{ method: string; id: string; text?: string }> = []
Object.assign(window, { __btwCalls: calls })
let refreshMain = () => {}
function message(id: string, seq: number, role: 'user' | 'agent', text: string): DecryptedMessage {
    return { id: `${id}-${seq}`, seq, createdAt: now + seq, localId: `${id}-${seq}`, invokedAt: now + seq,
        content: role === 'user' ? { role, content: { type: 'text', text } } : { role, content: { type: 'codex', data: { type: 'message', message: text } } } } as DecryptedMessage
}
transcript.set('main', [message('main', 1, 'user', 'Implement the main task. Keep running while I ask a side question.'), message('main', 2, 'agent', 'I’m working on the main task. The BTW conversation can run alongside it.')])
const api = new Proxy({
    createBtw: async (id: string) => {
        calls.push({ method: 'create', id })
        const sideId = `side-${sessions.size}`
        const side = { ...base, id: sideId, thinking: false, metadata: { ...base.metadata!, name: 'BTW', codexSideParentId: id,
            codexSessionId: `native-${sideId}`, capabilities: { concurrentClients: true } } }
        sessions.set(sideId, side)
        transcript.set(sideId, [message(sideId, 1, 'user', 'What does BTW inherit?'), message(sideId, 2, 'agent', 'BTW inherits the current context. The main task keeps running, and messages here stay in this conversation.')])
        base.metadata = { ...base.metadata!, codexSideThreads: [...base.metadata?.codexSideThreads ?? [], { sessionId: sideId, threadId: `native-${sideId}` }] }
        refreshMain(); return { sessionId: sideId }
    },
    getSession: async (id: string) => ({ session: sessions.get(id)! }),
    getSessions: async () => ({ sessions: [] }),
    getMachines: async () => ({ machines: [] }),
    getMessages: async (id: string) => {
        const messages = transcript.get(id) ?? []
        return { messages, page: { direction: 'latest', limit: 200, epoch: 1, reset: false, hasMore: false,
            nextBeforeSeq: messages[0]?.seq ?? null, nextBeforeAt: messages[0]?.createdAt ?? null,
            nextAfterSeq: messages.at(-1)?.seq ?? null, nextAfterAt: messages.at(-1)?.createdAt ?? null,
            snapshotHeadSeq: messages.at(-1)?.seq ?? null, snapshotHeadAt: messages.at(-1)?.createdAt ?? null } }
    },
    getScratchlist: async () => ({ entries: [] }),
    getQueuedState: async () => ({ queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [] }),
    getSessionCodexModels: async () => ({ success: true, models: [] }),
    getSlashCommands: async () => ({ commands: [] }),
    getSkills: async () => ({ skills: [] }),
    abortSession: async (id: string) => { calls.push({ method: 'abort', id }) },
    archiveSession: async (id: string) => {
        calls.push({ method: 'end', id })
        const session = sessions.get(id)!
        sessions.set(id, { ...session, active: false, metadata: { ...session.metadata!, codexSideEnded: true } })
        await client.invalidateQueries({ queryKey: queryKeys.session(id) })
    },
    sendMessage: async (id: string, text: string, localId: string) => {
        calls.push({ method: 'send', id, text })
        const messages = transcript.get(id) ?? []
        const user = { ...message(id, messages.length + 1, 'user', text), localId }
        const answer = message(id, messages.length + 2, 'agent', 'Side answer to: ' + text)
        transcript.set(id, [...messages, user, answer]); ingestIncomingMessages(id, [user, answer])
    },
} as unknown as ApiClient, { get(target, key) { return Reflect.get(target, key) ?? (async () => ({})) } })
function Fixture() {
    const [parent, setParent] = useState({ ...base })
    refreshMain = () => setParent({ ...base })
    return <div className="h-dvh"><SessionChat api={api} session={parent} messages={transcript.get('main')!}
        messagesWarning={null} hasMoreMessages={false} isSyncingTail={false} isLoadingMoreMessages={false} isSending={false}
        viewMode="tail" messagesVersion={1} historyVersion={1} tailRevision={1} onBack={() => {}} onRefresh={refreshMain}
        onLoadMore={async () => ({ kind: 'stopped', reason: 'exhausted' })} onCancelLoadMore={() => {}}
        onSend={async () => false} onViewModeChange={() => {}} onJumpToTail={() => {}} /></div>
}
const route = createRootRoute({ component: Fixture })
const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) })
createRoot(document.getElementById('root')!).render(<I18nProvider><QueryClientProvider client={client}><ToastProvider><PwaUpdateProvider><VoiceProvider>
    <AppContextProvider value={{ api, token: 'fixture-only', baseUrl: '' }}><RouterProvider router={router} /></AppContextProvider>
</VoiceProvider></PwaUpdateProvider></ToastProvider></QueryClientProvider></I18nProvider>)
