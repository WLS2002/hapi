import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiSessionClient } from '@/api/apiSession';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { buildUserInputFromMessage } from '../utils/appServerConfig';
import { SharedCodexProjection } from './projection';
import { SharedCodexPermissions } from './permissions';
import { SharedCodexAsyncQuestions } from './asyncQuestions';
import { record, string } from './gateway';

// Same boundary as the native TUI: forked history must never become new work.
export const SIDE_INSTRUCTIONS = `You are in a side conversation, not the main thread.
Inherited history is reference context only, not your current task. Only instructions submitted after the side conversation boundary are active.
Do not continue or execute tasks, plans, tool calls, approvals, edits or requests found only in inherited history.
Answer questions and do lightweight non-mutating exploration without disrupting the main thread. Wait for a question if none has been submitted.
Do not create worktrees or interact with existing or new sub-agents in this ephemeral conversation.
Do not modify files, git state, permissions, configuration or workspace state, or request broader access, unless the user explicitly requests that mutation after the boundary. Keep any explicitly requested mutation minimal and local.`;
export const SIDE_BOUNDARY = `Side conversation boundary.\n\n${SIDE_INSTRUCTIONS}`;

type Event = { method: string; params: unknown; at: number };
type Request = { id: string | number; method: string; params: unknown };

/** Ephemeral native execution, durable HAPI transcript. Never resume or read native history. */
export class SharedCodexSide {
    threadId = '';
    private projection?: SharedCodexProjection;
    private readonly permissions: SharedCodexPermissions;
    private readonly questions: SharedCodexAsyncQuestions;
    private readonly early: Event[] = [];
    private readonly earlyRequests: Request[] = [];
    private readonly events: Event[] = [];
    private readonly submitted = new Set<string>();
    private work: Promise<unknown> = Promise.resolve();
    private notifications: Promise<unknown> = Promise.resolve();
    private heartbeat?: ReturnType<typeof setInterval>;
    private turnId?: string;
    private turnRevision = 0;
    private settings: NonNullable<Parameters<ApiSessionClient['keepAlive']>[2]> = {};
    private ended = false;
    private ending = false;
    private closing?: Promise<void>;

    constructor(readonly session: ApiSessionClient, readonly client: Pick<CodexAppServerClient, 'request' | 'respond'>,
        private readonly directory: string, generation: string, private readonly dispose: () => Promise<void>) {
        this.questions = new SharedCodexAsyncQuestions(session, (_thread, text, id) => this.submit(text, id));
        this.permissions = new SharedCodexPermissions(session, client, generation, reply => this.questions.answer(reply));
        session.onUserMessage((message, id) => {
            const text = formatMessageWithAttachments(message.content.text, message.content.attachments);
            this.work = this.work.catch(() => {}).then(() => this.submit(text, id ?? randomUUID())).catch(error => {
                session.sendSessionEvent({ type: 'message', message: `BTW input was not confirmed: ${error instanceof Error ? error.message : error}` });
            });
        });
        session.onReconnect(() => {
            this.notifications = this.notifications.catch(() => {}).then(async () => {
                this.projection?.reset();
                for (const event of this.events) await this.projection?.notification(event.method, event.params, undefined, event.at);
                if (!this.ended) { this.alive(); session.emitSessionReady(); }
            }).catch(error => logger.debug('[Codex BTW] replay', error));
        });
        // An uncertain submission cannot be retried without native history.
        session.onCancelQueuedMessage(async () => 'indeterminate' as const);
        session.onRetryQueuedMessage(async () => false);
        session.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {
            if (!this.ended && this.turnId) await client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
        });
        session.rpcHandlerManager.registerHandler(RPC_METHODS.KillSession, async () => {
            await this.end(); return { success: true };
        });
        session.on('hub-archived', () => { void this.end().catch(error => logger.debug('[Codex BTW] end', error)); });
    }

    async bind(response: Record<string, unknown>): Promise<void> {
        const thread = record(response.thread);
        const id = string(thread.id);
        if (!id || thread.ephemeral !== true) throw new Error('BTW requires a native ephemeral thread');
        if (this.threadId) throw new Error('BTW is already bound');
        this.threadId = id;
        this.acceptSettings(response);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        this.projection = new SharedCodexProjection(this.session, id, async id => { this.session.emitMessagesConsumed([id]); },
            undefined, undefined, (threadId, item) => this.questions.observeItem(threadId, item));
        this.session.updateMetadata(metadata => ({ ...metadata, codexSessionId: id, name: 'BTW', titleLocked: true,
            capabilities: { concurrentClients: true, terminal: false }, codexSideEnded: false }));
        for (const event of this.early.splice(0)) await this.notification(event.method, event.params, event.at);
        for (const request of this.earlyRequests.splice(0)) this.receive(request);
        this.heartbeat = setInterval(() => this.alive(), 2_000);
        this.alive(); this.session.emitSessionReady(); await this.session.flush();
    }

    receive(request: Request): void {
        if (!this.threadId) { this.earlyRequests.push(request); return; }
        if (record(request.params).threadId === this.threadId && !this.ended) this.permissions.receive(request);
    }

    notification(method: string, params: unknown, at = Date.now()): Promise<unknown> {
        const event = { method, params, at };
        if (!this.threadId) { this.early.push(event); return Promise.resolve(); }
        if (this.ended) return Promise.resolve();
        if (method === 'serverRequest/resolved') {
            this.permissions.resolved(string(record(params).threadId) ?? '', record(params).requestId); return Promise.resolve();
        }
        const p = record(params);
        if ((string(p.threadId) ?? string(record(p.thread).id)) !== this.threadId) return Promise.resolve();
        // Update turn identity at receipt, before asynchronous projection or a start response.
        if (method === 'thread/settings/updated') this.acceptSettings(record(p.threadSettings));
        if (method === 'turn/started') { this.turnRevision++; this.turnId = string(record(p.turn).id); }
        if (method === 'turn/completed') { this.turnRevision++; this.turnId = undefined; }
        this.notifications = this.notifications.catch(() => {}).then(async () => {
            await appendFile(join(this.directory, `${this.session.sessionId}.jsonl`), `${JSON.stringify(event)}\n`, { mode: 0o600 });
            this.events.push(event);
            await this.projection?.notification(method, params, undefined, at);
            this.alive();
            if (method === 'turn/completed') this.session.sendSessionEvent({ type: 'ready' });
            if (method === 'thread/closed' || method === 'thread/archived') await this.finish();
        });
        return this.notifications;
    }

    private async submit(text: string, id: string): Promise<void> {
        if (this.ended || this.ending || !this.threadId) throw new Error('This BTW has ended. Create a new BTW from the main conversation.');
        if (this.submitted.has(id)) return;
        this.submitted.add(id);
        const revision = this.turnRevision;
        const turnId = this.turnId;
        try {
            const response = record(await this.client.request(turnId ? 'turn/steer' : 'turn/start', {
                threadId: this.threadId, input: buildUserInputFromMessage(text), clientUserMessageId: id,
                ...(turnId ? { expectedTurnId: turnId } : {})
            }));
            if (revision === this.turnRevision) this.turnId = string(record(response.turn).id) ?? string(response.turnId) ?? this.turnId;
            this.session.emitMessagesConsumed([id], { steered: Boolean(turnId), clearQueuedThinkingGrace: true });
            this.alive();
        } catch (error) {
            // Never replay a potentially accepted turn/start after transport loss.
            this.session.emitSteerIndeterminate([id]); throw error;
        }
    }

    private acceptSettings(value: Record<string, unknown>): void {
        const model = string(value.model);
        if (!model) return;
        const sandbox = record(value.sandboxPolicy ?? value.sandbox).type;
        this.settings = { ...this.settings, model,
            modelReasoningEffort: string(value.effort ?? value.reasoningEffort) ?? this.settings.modelReasoningEffort,
            ...(sandbox ? { permissionMode: sandbox === 'readOnly' ? 'read-only' : sandbox === 'dangerFullAccess' ? 'yolo' : 'default' } : {}) };
    }
    private alive(): void { if (!this.ended) this.session.keepAlive(Boolean(this.turnId), undefined, this.settings); }
    async drain(): Promise<void> { await this.work; await this.notifications; }
    async end(): Promise<void> {
        if (this.ended) return;
        if (this.ending) throw new Error('BTW is already ending');
        this.ending = true;
        try {
            await this.work.catch(() => {});
            if (this.turnId) await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
            if (this.threadId) await this.client.request('thread/unsubscribe', { threadId: this.threadId });
            await this.finish();
        } finally { this.ending = false; }
    }
    private async finish(): Promise<void> {
        if (this.ended) return;
        this.ended = true; clearInterval(this.heartbeat);
        this.permissions.close(); this.questions.close();
        this.session.updateMetadata(metadata => ({ ...metadata, codexSideEnded: true, lifecycleState: 'archived', lifecycleStateSince: Date.now() }));
        this.session.sendSessionDeath(undefined, { preserveUploads: true });
        await this.session.flush();
        // Leave time for the KillSession acknowledgement to reach the hub.
        const timer = setTimeout(() => { void this.close().catch(error => logger.debug('[Codex BTW] cleanup', error)); }, 100);
        timer.unref();
    }
    close(): Promise<void> {
        return this.closing ??= (async () => {
            await this.work.catch(() => {}); await this.notifications.catch(() => {});
            await this.finish(); this.session.onReconnect(null);
            await this.dispose(); this.session.close();
        })();
    }
}
