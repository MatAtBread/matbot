import type { Session, Tool } from '@matatbread/matbot-plugin-api';

export const MARKER_CREATOR = '@matatbread/matbot-function-tools';

/**
 * One step in a session's function history. The session IS the store for a session-scoped function: its
 * definitions ride as markers, replayed in order, so every session edit means the right thing with no
 * code here — a fork inherits what was defined before the fork point, a cut before the definition takes
 * it away, a compaction keeps it. A `split` can leave a later function calling one that went to the other
 * half; `check` finds that.
 */
export type SessionFunctionMarker =
  | { op: 'define'; name: string; definition: string; description?: string; definedUnchecked?: true }
  | { op: 'remove'; name: string };

declare module '@matatbread/matbot-plugin-api' {
  interface MarkerData {
    '@matatbread/matbot-function-tools': SessionFunctionMarker;
  }
}

export interface SessionFunctionRecord { name: string; definition: string; description?: string; definedUnchecked?: true }

/** The session's functions as they stand at its last message: every define, less every later remove. */
export function sessionFunctions(session: Session): Map<string, SessionFunctionRecord> {
  const out = new Map<string, SessionFunctionRecord>();
  for (const m of session.messages) {
    if (m.role !== 'marker') continue;
    for (const c of m.content) {
      if (c.type !== 'marker' || c.creator !== MARKER_CREATOR) continue;
      // Persisted data, so checked rather than trusted: a hand-edited or foreign marker is skipped.
      const d = c.data as Partial<SessionFunctionMarker> | null;
      if (d === null || typeof d !== 'object' || typeof d.name !== 'string') continue;
      if (d.op === 'remove') { out.delete(d.name); continue; }
      if (d.op !== 'define' || typeof d.definition !== 'string') continue;
      out.set(d.name, {
        name: d.name, definition: d.definition,
        ...(typeof d.description === 'string' ? { description: d.description } : {}),
        ...(d.definedUnchecked === true ? { definedUnchecked: true as const } : {}),
      });
    }
  }
  return out;
}

/**
 * A `ToolContracts` augmentation declaring this turn's tools, appended AFTER a snippet so the checker
 * types `await tool.<turn tool>(…)` exactly as it types a registered one. After, not before: the snippet's
 * diagnostics are numbered from its first line, and declaration merging does not care where the block
 * sits. The blank lines keep it out of the code frame of an error on the snippet's last line.
 *
 * Built from the turn's tools — the very map `tool.x()` resolves through at run time — and never from
 * the markers, so what passes the check is exactly what will be callable. `own` adds the function being
 * checked, replacing any older arm of the same name (a re-definition may change its contract, and two
 * arms of one name are a TS2717).
 */
export function turnContracts(turnTools: ReadonlyMap<string, Tool> | undefined, own?: { name: string; contract: string }): string {
  const arms = new Map<string, string>();
  for (const t of turnTools?.values() ?? []) arms.set(t.name, t.toolContract ?? 'ToolContract<unknown, unknown>');
  if (own !== undefined) arms.set(own.name, own.contract);
  if (arms.size === 0) return '';
  const body = [...arms]
    .map(([name, contract]) => `${JSON.stringify(name)}: ${contract.replace(/\bToolContract</g, "import('@matatbread/matbot-plugin-api').ToolContract<")};`)
    .join(' ');
  return `\n\n\ndeclare module '@matatbread/matbot-plugin-api' { interface ToolContracts { ${body} } }`;
}

/** The error a session function gets for a name the registry already holds — at definition, and on any
 *  later turn where a global tool has since taken the name. */
export const shadowMessage = (name: string): string =>
  `The tool ${name} can't be added to this turn as it would shadow the global tool with the same name. Pick a unique name`;
