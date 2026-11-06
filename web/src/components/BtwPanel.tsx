import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import type { SessionChatProps } from './SessionChat'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useSession } from '@/hooks/queries/useSession'
import { useMessages } from '@/hooks/queries/useMessages'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { useSSE } from '@/hooks/useSSE'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export function BtwPanel(props: {
    api: ApiClient
    parent: Session
    onClose: () => void
    onCreated: () => void
    renderConversation: (id: string) => ReactNode
}) {
    const { t } = useTranslation()
    const selectId = useId()
    const storageKey = `hapi.btw.selected.${props.parent.id}`
    const [selected, setSelected] = useState(() => {
        try { return localStorage.getItem(storageKey) ?? '' } catch { return '' }
    })
    const [created, setCreated] = useState<string[]>([])
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const ids = [...new Set([...(props.parent.metadata?.codexSideThreads ?? []).map(side => side.sessionId), ...created])]
    const current = ids.includes(selected) ? selected : ids.at(-1) ?? ''
    useEffect(() => {
        if (current) try { localStorage.setItem(storageKey, current) } catch { /* Storage can be disabled. */ }
    }, [current, storageKey])
    const create = async () => {
        if (pending) return
        setPending(true); setError(null)
        try {
            const result = await props.api.createBtw(props.parent.id)
            setCreated(prior => [...prior, result.sessionId]); setSelected(result.sessionId)
            props.onCreated()
        } catch (error) { setError(error instanceof Error ? error.message : t('btw.createFailed')) }
        finally { setPending(false) }
    }
    return (
        <section aria-label="BTW" className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--app-bg)]">
            <div className="flex min-h-14 items-center gap-2 border-b border-[var(--app-divider)] px-3 py-2">
                <button type="button" onClick={props.onClose} aria-label={t('btw.back')}
                    className="inline-flex size-10 shrink-0 items-center justify-center rounded-md hover:bg-[var(--app-subtle-bg)] focus-visible:outline-2 focus-visible:outline-[var(--app-link)]">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
                </button>
                <h2 className="font-semibold">BTW</h2>
                <label htmlFor={selectId} className="sr-only">{t('btw.conversations')}</label>
                <select id={selectId} value={current} onChange={event => setSelected(event.target.value)} disabled={!ids.length}
                    className="min-w-0 flex-1 rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-2 text-sm">
                    {!ids.length ? <option value="">{t('btw.noConversations')}</option> : null}
                    {ids.map((id, index) => <option key={id} value={id}>BTW {index + 1}</option>)}
                </select>
                <button type="button" onClick={() => void create()} disabled={pending || !props.parent.active || !props.parent.metadata?.capabilities?.btw}
                    className="min-h-10 shrink-0 rounded-md bg-[var(--app-button)] px-3 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-50">
                    {pending ? t('btw.creating') : t('btw.new')}
                </button>
            </div>
            {error ? <div role="alert" className="border-b border-[var(--app-divider)] p-3 text-sm text-[var(--app-fg)]">{error}</div> : null}
            <div className="min-h-0 flex-1">
                {current ? props.renderConversation(current) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                        <p className="text-base font-medium">{t('btw.emptyTitle')}</p>
                        <p className="max-w-sm text-sm text-[var(--app-hint)]">{t('btw.emptyDescription')}</p>
                    </div>
                )}
            </div>
        </section>
    )
}

/** Reuses normal chat storage, approvals and drafts, with a second scoped SSE subscription. */
export function BtwConversation(props: { id: string; onBack: () => void; renderChat: (props: SessionChatProps) => ReactNode }) {
    const { api, token, baseUrl } = useAppContext()
    const { t } = useTranslation()
    const detail = useSession(api, props.id)
    const messages = useMessages(api, props.id)
    const send = useSendMessage(api, props.id)
    const [ending, setEnding] = useState(false)
    const [confirmEnd, setConfirmEnd] = useState(false)
    const subscription = useMemo(() => ({ sessionId: props.id }), [props.id])
    useSSE({ enabled: true, token, baseUrl, subscription, scope: 'full', onEvent: () => {},
        onConnect: () => { void detail.refetch(); void messages.refetch() } })
    if (!detail.session) return <div role="status" className="p-4 text-sm">{detail.error ?? t('loading.session')}</div>
    const session = detail.session
    return <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--app-divider)] px-4 py-2 text-sm">
            <span>{!session.active || session.metadata?.codexSideEnded ? t('btw.ended') : session.thinking ? t('btw.working') : t('btw.ready')}</span>
            {session.active && !session.metadata?.codexSideEnded ? <button type="button" onClick={() => setConfirmEnd(true)}
                className="min-h-9 rounded-md px-3 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">{t('btw.end')}</button> : null}
        </div>
        <div className="min-h-0 flex-1">{props.renderChat({
            api, session, messages: messages.messages, messagesWarning: messages.warning,
            hasMoreMessages: messages.hasMore, hasMoreNewerMessages: messages.hasMoreNewer,
            isSyncingTail: messages.isSyncingTail, isLoadingMoreMessages: messages.isLoadingMore,
            isSending: send.isSending, viewMode: messages.viewMode, messagesVersion: messages.messagesVersion,
            historyVersion: messages.historyVersion, tailRevision: messages.tailRevision,
            onBack: props.onBack, onRefresh: async () => { await detail.refetch(); await messages.refetch() },
            onLoadMore: messages.loadMore, onLoadNewer: async () => (await messages.loadNewer()).kind === 'loaded',
            onCancelLoadMore: messages.cancelLoadMore, onSend: send.sendMessage,
            onViewModeChange: messages.setViewMode, onJumpToTail: messages.jumpToTail,
            onRetryMessage: send.retryMessage,
        })}</div>
        <ConfirmDialog isOpen={confirmEnd} onClose={() => setConfirmEnd(false)} title={t('btw.end')}
            description={t('btw.endDescription')} confirmLabel={t('btw.end')} confirmingLabel={t('btw.ending')} isPending={ending}
            onConfirm={async () => { setEnding(true); try { await api.archiveSession(props.id); await detail.refetch() } finally { setEnding(false) } }} />
    </div>
}
