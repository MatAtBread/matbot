import type { CallFrame } from './types/messages.js';
import type { ToolEvent } from './types/tools.js';

/**
 * The frames a nested call's marker carries up to the call that made it (see {@link CallFrame}).
 *
 * A symbol rather than a field of the `marker` event, because the event is the tool's to write and the
 * frames must not be: anything a tool yields that names where it came from is a claim, and the point of
 * `by` is that it is not one. JSON cannot carry a symbol, so model-authored data never can; a plugin that
 * imports this from `/host` is host code by its own choice, which no in-process boundary stops anyway.
 *
 * It rides on the event OBJECT, so a box owner that yields the event it was handed (function-tools' queue)
 * passes the frames on with no knowledge of them. Spreading the event keeps it too (own symbol properties
 * are copied); building a new event from `creator` and `data` drops it, which is the safe failure.
 */
const CALL_FRAMES: unique symbol = Symbol('matbot.callFrames');

type Framed = { [CALL_FRAMES]?: readonly CallFrame[] };

/** The frames the host attached to a marker event, innermost call last; `undefined` if none. */
export function callFramesOf(ev: ToolEvent<unknown>): readonly CallFrame[] | undefined {
  return ev.type === 'marker' ? (ev as Framed)[CALL_FRAMES] : undefined;
}

/** A marker event carrying `frames`: a new object, built from `creator` and `data` only. */
export function withCallFrames(ev: Extract<ToolEvent<unknown>, { type: 'marker' }>, frames: readonly CallFrame[]): Extract<ToolEvent<never>, { type: 'marker' }> {
  const out: Extract<ToolEvent<never>, { type: 'marker' }> & Framed = { type: 'marker', creator: ev.creator, data: ev.data };
  out[CALL_FRAMES] = frames;
  return out;
}

/** The frame for a call to `tool`, from what the host knows of it: its name and the plugin that registered it. */
export function callFrame(tool: string, registered: { pluginName?: string } | null | undefined, callId?: string): CallFrame {
  return {
    tool,
    ...(registered?.pluginName !== undefined ? { plugin: registered.pluginName } : {}),
    ...(callId !== undefined ? { callId } : {}),
  };
}
