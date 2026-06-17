import type {
  Hook, HookPoint, Message, MessageContent, Session,
  ScreenContext, ContributeContext, ToolCallContext, ToolCallResult, ToolResultContext, FollowupContext,
} from './types.js';

const HOOK_ERROR_CREATOR = 'matbot-hooks';

export class HookRegistry {
  private readonly hooks = new Map<HookPoint, Hook[]>();

  // A hook handler that *throws* is a failure, not an intentional stop (which is a return value:
  // `abort` / `rejectTool`). A throw must never propagate out of a run* method — that is what bricked
  // the turn loop: one misconfigured screen hook (e.g. a provider with an unresolved secret) threw at
  // the top of every turn, so the model never ran and the user couldn't even invoke a tool to fix it.
  // So every handler call goes through `invoke`, which catches, logs, and treats the throw as "the
  // hook returned nothing" (skipped). The failure is recorded once per hook (`markedFailures`) and
  // drained into a marker by the next `runScreen`, so it degrades *visibly* rather than silently.
  private readonly markedFailures = new Set<Hook>();
  private pendingFailureMarkers: { channel: HookPoint; pluginName?: string; message: string }[] = [];

  register(hook: Hook): void {
    const list = this.hooks.get(hook.on) ?? [];
    list.push(hook);
    list.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    this.hooks.set(hook.on, list);
  }

  removeByPlugin(pluginName: string): void {
    for (const [point, list] of this.hooks) {
      this.hooks.set(point, list.filter(h => h.pluginName !== pluginName));
    }
  }

  // Backing for the per-call `ctx.removeHook()`: drop one hook by identity. Filtering into a fresh
  // array (rather than splicing) leaves any in-flight run loop — which iterates the array reference
  // it captured before the mutation — to finish over the old list; the next run sees the new one.
  // Idempotent: removing an already-absent hook is a no-op, so calling removeHook() twice is safe.
  private removeOne(point: HookPoint, hook: Hook): void {
    const list = this.hooks.get(point);
    if (list) this.hooks.set(point, list.filter(h => h !== hook));
  }

  // Run one handler, isolating a throw: log it, record it for a one-time marker, and return undefined
  // — which every run* method already treats as "no contribution from this hook".
  private async invoke<R>(hook: Hook, run: () => R | Promise<R>): Promise<R | undefined> {
    try {
      return await run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const owner = hook.pluginName !== undefined ? ` from "${hook.pluginName}"` : '';
      console.error(`[matbot] ${hook.on} hook${owner} threw; skipping it for this turn:`, message);
      if (!this.markedFailures.has(hook)) {
        this.markedFailures.add(hook);
        this.pendingFailureMarkers.push({
          channel: hook.on,
          ...(hook.pluginName !== undefined ? { pluginName: hook.pluginName } : {}),
          message,
        });
      }
      return undefined;
    }
  }

  // Append a `marker` message for each not-yet-marked hook failure (from any channel) to the session,
  // then clear the queue. Called from runScreen — the once-per-turn, session-owning channel whose
  // returned session the runner persists — so failures surface durably and exactly once. Returns the
  // appended marker content blocks too, so the runner can carry them live (a session reload is the
  // fallback path, not the only one).
  private drainFailureMarkers(session: Session): { session: Session; markers: MessageContent[] } {
    if (this.pendingFailureMarkers.length === 0) return { session, markers: [] };
    const messages: Message[] = this.pendingFailureMarkers.map(f => ({
      id:        crypto.randomUUID(),
      role:      'marker',
      createdAt: new Date().toISOString(),
      traceId:   '',
      content:   [{
        type:    'marker',
        creator: HOOK_ERROR_CREATOR,
        data:    { channel: f.channel, ...(f.pluginName !== undefined ? { pluginName: f.pluginName } : {}), message: f.message },
      }],
    }));
    this.pendingFailureMarkers = [];
    return {
      session: { ...session, messages: [...session.messages, ...messages] },
      markers: messages.flatMap(m => m.content),
    };
  }

  // screen folds across hooks: each sees the session as shaped so far, accumulates ephemeral, and
  // the first `abort` short-circuits (the partial session is returned so the caller can persist it).
  async runScreen(ctx: Omit<ScreenContext, 'removeHook'>): Promise<{ session: Session; ephemeral: MessageContent[]; markers: MessageContent[]; abort?: string }> {
    let session = ctx.session;
    const ephemeral: MessageContent[] = [];
    // Handler-returned markers: appended to the session here (so they persist) and accumulated so the
    // runner can also emit them live — keeping a live draw and a reload identical.
    const handlerMarkers: MessageContent[] = [];
    const appendMarkers = (blocks: MessageContent[]): void => {
      handlerMarkers.push(...blocks);
      session = { ...session, messages: [...session.messages, {
        id: crypto.randomUUID(), role: 'marker', createdAt: new Date().toISOString(), traceId: '', content: blocks,
      }] };
    };
    for (const hook of this.hooks.get('screen') ?? []) {
      if (hook.on !== 'screen') continue;
      const r = await this.invoke(hook, () => hook.handler({ ...ctx, session, removeHook: () => this.removeOne('screen', hook) }));
      if (!r) continue;
      if (r.session)                 session = r.session;
      if (r.ephemeral)               ephemeral.push(...r.ephemeral);
      if (r.markers && r.markers.length) appendMarkers(r.markers);
      if (r.abort) {
        const drained = this.drainFailureMarkers(session);
        return { session: drained.session, ephemeral, markers: [...handlerMarkers, ...drained.markers], abort: r.abort };
      }
    }
    const drained = this.drainFailureMarkers(session);
    return { session: drained.session, ephemeral, markers: [...handlerMarkers, ...drained.markers] };
  }

  // contribute folds the outgoing array through each hook — a pure transform pipeline; the stored
  // session is never touched.
  async runContribute(ctx: Omit<ContributeContext, 'removeHook'>): Promise<Message[]> {
    let outgoing = ctx.outgoing as Message[];
    for (const hook of this.hooks.get('contribute') ?? []) {
      if (hook.on !== 'contribute') continue;
      const r = await this.invoke(hook, () => hook.handler({ ...ctx, outgoing, removeHook: () => this.removeOne('contribute', hook) }));
      if (r) outgoing = r;
    }
    return outgoing;
  }

  // toolcall stops at the first hook that rejects or aborts; the rest don't run.
  async runToolCall(ctx: Omit<ToolCallContext, 'removeHook'>): Promise<ToolCallResult> {
    for (const hook of this.hooks.get('toolcall') ?? []) {
      if (hook.on !== 'toolcall') continue;
      const r = await this.invoke(hook, () => hook.handler({ ...ctx, removeHook: () => this.removeOne('toolcall', hook) }));
      if (r && (r.rejectTool || r.abort)) return r;
    }
    return {};
  }

  // toolresult folds the tool result through each hook — a transform pipeline (redaction, truncation);
  // a hook that returns nothing just observes (auditing). Returns the final result.
  async runToolResult(ctx: Omit<ToolResultContext, 'removeHook'>): Promise<unknown> {
    let result = ctx.result;
    for (const hook of this.hooks.get('toolresult') ?? []) {
      if (hook.on !== 'toolresult') continue;
      const r = await this.invoke(hook, () => hook.handler({ ...ctx, result, removeHook: () => this.removeOne('toolresult', hook) }));
      if (r) result = r.result;
    }
    return result;
  }

  // followup runs every hook and collects their resubmissions (each becomes its own head-enqueued
  // turn) and any durable markers (appended to the committed session by the pump).
  async runFollowup(ctx: Omit<FollowupContext, 'removeHook'>): Promise<{ resubmits: MessageContent[][]; markers: MessageContent[] }> {
    const resubmits: MessageContent[][] = [];
    const markers:   MessageContent[]   = [];
    for (const hook of this.hooks.get('followup') ?? []) {
      if (hook.on !== 'followup') continue;
      const r = await this.invoke(hook, () => hook.handler({ ...ctx, removeHook: () => this.removeOne('followup', hook) }));
      if (r?.resubmit) resubmits.push(r.resubmit.content);
      if (r?.markers)  markers.push(...r.markers);
    }
    return { resubmits, markers };
  }
}
