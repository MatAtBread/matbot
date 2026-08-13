import type {
  Hook, HookPoint, HookRegistrar, Message, MessageContent, Session, DeferredScreen,
  ScreenContext, ContributeContext, ToolCallContext, ToolCallResult, ToolResultContext, FollowupContext,
} from './types.js';
import { foldOntoUserTurn } from './session.js';
import { withUsageSite } from './usage-context.js';

const HOOK_ERROR_CREATOR = 'matbot-hooks';

export class HookRegistry implements HookRegistrar {
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
  //
  // Also the accounting push site for the `hook` call site: a handler that runs a completion (a trigger
  // classifier, a router) records against the channel and plugin that owns it. Established here rather
  // than per-channel because it is the one place every handler invocation passes through — and because
  // the site must be in force when the handler *starts*, so work it kicks off detached stays attributed
  // to it however late it settles.
  private async invoke<R>(hook: Hook, run: () => R | Promise<R>): Promise<R | undefined> {
    try {
      return await withUsageSite(
        { kind: 'hook', channel: hook.on, ...(hook.pluginName !== undefined ? { plugin: hook.pluginName } : {}) },
        run,
      );
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
  async runScreen(ctx: Omit<ScreenContext, 'removeHook'>): Promise<{ session: Session; ephemeral: MessageContent[]; durable: MessageContent[]; markers: MessageContent[]; deferred: DeferredScreen[]; abort?: string }> {
    let session = ctx.session;
    const ephemeral: MessageContent[] = [];
    // Raced verdicts handed back by hooks: the runner polls each without gating the turn (see
    // DeferredScreen). Usually zero or one; an array so several racing hooks compose.
    const deferred: DeferredScreen[] = [];
    // Handler-returned markers: appended to the session here (so they persist) and accumulated so the
    // runner can also emit them live — keeping a live draw and a reload identical.
    const handlerMarkers: MessageContent[] = [];
    const appendMarkers = (blocks: MessageContent[]): void => {
      handlerMarkers.push(...blocks);
      session = { ...session, messages: [...session.messages, {
        id: crypto.randomUUID(), role: 'marker', createdAt: new Date().toISOString(), traceId: '', content: blocks,
      }] };
    };
    // Handler-returned durable context: folded onto the running turn's user message (the last one
    // with role 'user'), so it persists into history AND rides every subsequent provider call — the
    // persisted twin of `ephemeral`. Accumulated too, so the runner emits it live as a `robo-user`
    // event (keeping live draw and reload identical). No user message ⇒ nothing to fold onto, so the
    // blocks are dropped rather than orphaned (a screen hook only runs when a turn is being submitted,
    // so a user message is present in practice; this is defensive).
    const durable: MessageContent[] = [];
    const foldDurable = (blocks: MessageContent[]): void => {
      const folded = foldOntoUserTurn(session, blocks);
      if (folded === session) return;      // no user message to attach to — dropped, not orphaned
      durable.push(...blocks);
      session = folded;
    };
    for (const hook of this.hooks.get('screen') ?? []) {
      if (hook.on !== 'screen') continue;
      const r = await this.invoke(hook, () => hook.handler({ ...ctx, session, removeHook: () => this.removeOne('screen', hook) }));
      if (!r) continue;
      if (r.session)                     session = r.session;
      if (r.ephemeral)                   ephemeral.push(...r.ephemeral);
      if (r.durable && r.durable.length) foldDurable(r.durable);
      if (r.markers && r.markers.length) appendMarkers(r.markers);
      if (r.deferred)                    deferred.push(r.deferred);
      if (r.abort) {
        const drained = this.drainFailureMarkers(session);
        return { session: drained.session, ephemeral, durable, markers: [...handlerMarkers, ...drained.markers], deferred, abort: r.abort };
      }
    }
    const drained = this.drainFailureMarkers(session);
    return { session: drained.session, ephemeral, durable, markers: [...handlerMarkers, ...drained.markers], deferred };
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
  // turn), any durable markers (appended to the committed session by the pump), and any
  // retract-and-rerun requests. A turn can be popped only once, so multiple hooks' retraction
  // contexts merge into a single redo (in practice only one fires); `retract` is omitted when none did.
  async runFollowup(ctx: Omit<FollowupContext, 'removeHook'>): Promise<{ resubmits: MessageContent[][]; markers: MessageContent[]; retract?: { context: MessageContent[]; durable: MessageContent[] } }> {
    const resubmits:    MessageContent[][] = [];
    const markers:      MessageContent[]   = [];
    const retractCtx:   MessageContent[]   = [];
    const retractDur:   MessageContent[]   = [];
    for (const hook of this.hooks.get('followup') ?? []) {
      if (hook.on !== 'followup') continue;
      const r = await this.invoke(hook, () => hook.handler({ ...ctx, removeHook: () => this.removeOne('followup', hook) }));
      if (r?.resubmit)        resubmits.push(r.resubmit.content);
      if (r?.retractAndRerun) {
        if (r.retractAndRerun.context) retractCtx.push(...r.retractAndRerun.context);
        if (r.retractAndRerun.durable) retractDur.push(...r.retractAndRerun.durable);
      }
      if (r?.markers)         markers.push(...r.markers);
    }
    const retracting = retractCtx.length > 0 || retractDur.length > 0;
    return { resubmits, markers, ...(retracting ? { retract: { context: retractCtx, durable: retractDur } } : {}) };
  }
}
