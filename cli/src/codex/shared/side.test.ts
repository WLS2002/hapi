import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata, AgentState } from '@/api/types';
import { SharedCodexSide } from './side';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0)) await run(); });

async function fixture() {
    const directory = await mkdtemp('/tmp/hapi-side-test-');
    let metadata: Metadata = { path: directory, host: 'test', flavor: 'codex', codexSideParentId: 'parent' };
    let state: AgentState = {};
    const messages: unknown[] = [];
    const consumed: string[] = [];
    const rpc = new Map<string, (p: unknown) => Promise<unknown>>();
    let user!: (m: { content: { text: string } }, id?: string) => void;
    let reconnect!: () => void;
    const session = { sessionId: 'side-sid', getMetadata: () => metadata,
        updateMetadata: (fn: (m: Metadata) => Metadata) => { metadata = fn(metadata); },
        updateAgentState: (fn: (s: AgentState) => AgentState) => { state = fn(state); },
        rpcHandlerManager: { registerHandler: (name: string, handler: (p: unknown) => Promise<unknown>) => rpc.set(name, handler) },
        onUserMessage: (fn: typeof user) => { user = fn; }, onReconnect: (fn: typeof reconnect) => { reconnect = fn; },
        on() {}, onCancelQueuedMessage() {}, onRetryQueuedMessage() {},
        sendAgentMessage: (body: unknown) => { messages.push(body); }, sendUserMessage: (text: string) => { messages.push({ user: text }); },
        sendSessionEvent: (body: unknown) => { messages.push(body); },
        emitMessagesConsumed: (ids: string[]) => { consumed.push(...ids); }, emitSteerIndeterminate() {},
        keepAlive() {}, emitSessionReady() {}, sendSessionDeath() {}, async flush() {}, close() {}
    } as unknown as ApiSessionClient;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = { async request(method: string, params: Record<string, unknown> = {}) {
        requests.push({ method, params });
        if (method === 'turn/start') return { turn: { id: 'side-turn' } };
        if (method === 'turn/steer') return { turnId: 'side-turn' };
        return {};
    }, respond() {}, isInitialized: () => true };
    const side = new SharedCodexSide(session, client as never, directory, 'generation', async () => {});
    cleanup.push(async () => { await side.close(); await rm(directory, { recursive: true, force: true }); });
    return { side, session, requests, messages, consumed, rpc, user: (text: string, id = 'input') => user({ content: { text } }, id),
        reconnect: () => reconnect(), metadata: () => metadata, state: () => state };
}

describe('native BTW session', () => {
    it('retains early side events, isolates siblings and replays after hub reconnect', async () => {
        const f = await fixture();
        await f.side.notification('item/completed', { threadId: 'native-side', turnId: 't', item: { type: 'agentMessage', id: 'a', text: 'SIDE ONLY' } });
        await f.side.notification('item/completed', { threadId: 'other', turnId: 't', item: { type: 'agentMessage', id: 'b', text: 'OTHER' } });
        await f.side.bind({ thread: { id: 'native-side', ephemeral: true } });
        expect(f.messages).toContainEqual(expect.objectContaining({ type: 'message', message: 'SIDE ONLY' }));
        expect(JSON.stringify(f.messages)).not.toContain('OTHER');
        expect(f.metadata().codexSessionId).toBe('native-side');
        f.messages.length = 0;
        f.reconnect();
        await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ type: 'message', message: 'SIDE ONLY' })));
        expect(f.requests.some(r => ['thread/resume', 'thread/read'].includes(r.method))).toBe(false);
    });
    it('sends and interrupts only the side and never replays an accepted input', async () => {
        const f = await fixture(); await f.side.bind({ thread: { id: 'native-side', ephemeral: true } });
        f.user('my question');
        await vi.waitFor(() => expect(f.requests).toContainEqual(expect.objectContaining({ method: 'turn/start', params: expect.objectContaining({ threadId: 'native-side', clientUserMessageId: 'input' }) })));
        expect(f.consumed).toContain('input');
        f.user('my question');
        await f.side.drain();
        expect(f.requests.filter(r => r.method === 'turn/start')).toHaveLength(1);
        await f.rpc.get(RPC_METHODS.Abort)!({});
        expect(f.requests.at(-1)).toEqual({ method: 'turn/interrupt', params: { threadId: 'native-side', turnId: 'side-turn' } });
        expect(f.requests.some(r => r.params.threadId === 'parent')).toBe(false);
    });
    it('ending a side preserves its transcript and rejects later input', async () => {
        const f = await fixture(); await f.side.bind({ thread: { id: 'native-side', ephemeral: true } });
        await f.rpc.get(RPC_METHODS.KillSession)!({});
        expect(f.metadata().codexSideEnded).toBe(true);
        f.user('should not run'); await f.side.drain();
        expect(f.requests.some(r => r.method === 'turn/start')).toBe(false);
    });
});

it('retries a failed end instead of falsely acknowledging it', async () => {
    const f = await fixture(); await f.side.bind({ thread: { id: 'native-side', ephemeral: true } });
    const request = f.side.client.request.bind(f.side.client);
    let rejectFirst = true;
    f.side.client.request = async (method, params) => {
        if (method === 'thread/unsubscribe' && rejectFirst) { rejectFirst = false; throw new Error('temporary failure'); }
        return request(method, params) as never;
    };
    await expect(f.rpc.get(RPC_METHODS.KillSession)!({})).rejects.toThrow('temporary failure');
    expect(f.metadata().codexSideEnded).toBe(false);
    await expect(f.rpc.get(RPC_METHODS.KillSession)!({})).resolves.toEqual({ success: true });
    expect(f.metadata().codexSideEnded).toBe(true);
});
