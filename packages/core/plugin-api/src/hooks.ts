import type {
  Hook, HookPoint, Message, MessageContent, Session,
  ScreenContext, ContributeContext, ToolCallContext, ToolCallResult, ToolResultContext, FollowupContext,
} from './types.js';

export class HookRegistry {
  private readonly hooks = new Map<HookPoint, Hook[]>();

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

  // screen folds across hooks: each sees the session as shaped so far, accumulates ephemeral, and
  // the first `abort` short-circuits (the partial session is returned so the caller can persist it).
  async runScreen(ctx: ScreenContext): Promise<{ session: Session; ephemeral: MessageContent[]; abort?: string }> {
    let session = ctx.session;
    const ephemeral: MessageContent[] = [];
    for (const hook of this.hooks.get('screen') ?? []) {
      if (hook.on !== 'screen') continue;
      const r = await hook.handler({ ...ctx, session });
      if (!r) continue;
      if (r.session)   session = r.session;
      if (r.ephemeral) ephemeral.push(...r.ephemeral);
      if (r.abort)     return { session, ephemeral, abort: r.abort };
    }
    return { session, ephemeral };
  }

  // contribute folds the outgoing array through each hook — a pure transform pipeline; the stored
  // session is never touched.
  async runContribute(ctx: ContributeContext): Promise<Message[]> {
    let outgoing = ctx.outgoing as Message[];
    for (const hook of this.hooks.get('contribute') ?? []) {
      if (hook.on !== 'contribute') continue;
      const r = await hook.handler({ ...ctx, outgoing });
      if (r) outgoing = r;
    }
    return outgoing;
  }

  // toolcall stops at the first hook that rejects or aborts; the rest don't run.
  async runToolCall(ctx: ToolCallContext): Promise<ToolCallResult> {
    for (const hook of this.hooks.get('toolcall') ?? []) {
      if (hook.on !== 'toolcall') continue;
      const r = await hook.handler(ctx);
      if (r && (r.rejectTool || r.abort)) return r;
    }
    return {};
  }

  // toolresult folds the tool result through each hook — a transform pipeline (redaction, truncation);
  // a hook that returns nothing just observes (auditing). Returns the final result.
  async runToolResult(ctx: ToolResultContext): Promise<unknown> {
    let result = ctx.result;
    for (const hook of this.hooks.get('toolresult') ?? []) {
      if (hook.on !== 'toolresult') continue;
      const r = await hook.handler({ ...ctx, result });
      if (r) result = r.result;
    }
    return result;
  }

  // followup runs every hook and collects their resubmissions (each becomes its own head-enqueued turn).
  async runFollowup(ctx: FollowupContext): Promise<MessageContent[][]> {
    const resubmits: MessageContent[][] = [];
    for (const hook of this.hooks.get('followup') ?? []) {
      if (hook.on !== 'followup') continue;
      const r = await hook.handler(ctx);
      if (r?.resubmit) resubmits.push(r.resubmit.content);
    }
    return resubmits;
  }
}
