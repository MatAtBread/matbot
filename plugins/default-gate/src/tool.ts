import type { PluginSettings, Tool, ToolContract, ToolResultOf } from '@matatbread/matbot-plugin-api';
import { KNOWN_GATES, WRITTEN_GATES_KEY, toStandingAnswer, type StandingAnswer } from './gate.js';

/** One gate id's answer as reported: `ask` is the resting state, `always` allows every subject, and
 *  `subjects` lists the ones allowed. What is *in effect*, never what is pinned — a stored answer and
 *  an installation's `default_settings:` floor read identically here, because that is the question the
 *  caller is asking ("will this prompt appear?") and the two are the same answer to it. */
export interface GateAnswer {
  gate:      string;
  effect:    'ask' | 'always' | 'subjects';
  subjects?: readonly string[];
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    gate_action:
      | ToolContract<{ answers: GateAnswer[] }, { action: 'get'; gate?: string }>
      | ToolContract<{ cleared: string[]; message: string }, { action: 'clear'; gate?: string; subject?: string }>;
  }
}

type GateInput =
  | { action: 'get';   gate?: string }
  | { action: 'clear'; gate?: string; subject?: string };

const describe = (gate: string, answer: StandingAnswer | undefined): GateAnswer =>
  answer === true                     ? { gate, effect: 'always' }
  : answer === undefined              ? { gate, effect: 'ask' }
  : answer.length === 0               ? { gate, effect: 'ask' }
  :                                     { gate, effect: 'subjects', subjects: answer };

export function makeGateActionTool(settings: PluginSettings): Tool<ToolResultOf<'gate_action'>> {
  // The ids to report on: the documented vocabulary plus anything this policy has actually stored,
  // which is the only way a gate id from a plugin this build never compiled against can be named.
  const gateIds = async (): Promise<string[]> => {
    const written = await settings.get<unknown>(WRITTEN_GATES_KEY);
    const ids     = Array.isArray(written) ? written.filter((g): g is string => typeof g === 'string') : [];
    return [...new Set([...KNOWN_GATES, ...ids])];
  };

  return {
    name: 'gate_action',
    description:
      'Inspect and forget the standing answers this installation\'s permission policy remembers.\n\n' +
      'A privileged operation — installing a plugin, adding a provider profile, overwriting a tool ' +
      'another plugin owns — asks the user to accept it. Answering "Always allow …" at that prompt ' +
      'stores a standing answer, after which the same operation proceeds silently.\n\n' +
      '"get" reports what is IN EFFECT for each gate, which may come from a stored answer or from the ' +
      'installation\'s configured defaults — the two are indistinguishable here on purpose, because the ' +
      'question is whether the prompt will appear. Pass "gate" to report one gate id.\n\n' +
      '"clear" forgets answers, so the operation asks again: with no arguments every gate, with "gate" ' +
      'that gate alone, and with "gate" + "subject" just that subject. Clearing means "revert to the ' +
      'configured default", so a gate an installation configured in its own config keeps that setting.\n\n' +
      'This tool cannot GRANT permission: the only way to author a standing answer at runtime is to ' +
      'answer a prompt that names the specific act.',
    inputSchema: {
      type:     'object',
      required: ['action'],
      properties: {
        action:  { type: 'string', enum: ['get', 'clear'], description: 'The operation to perform.' },
        gate:    { type: 'string', description: 'A gate id, e.g. "plugin.add" or "tools.overwrite". Optional for both actions: absent means every gate.' },
        subject: { type: 'string', description: 'clear only: forget just this subject (a tool name, plugin specifier, provider profile, MCP server) rather than the whole gate. Requires "gate".' },
      },
    },
    executor: {
      async *execute(input) {
        const act = input as GateInput;

        if (act.action === 'get') {
          const ids = act.gate !== undefined ? [act.gate] : await gateIds();
          const answers: GateAnswer[] = [];
          for (const gate of ids) answers.push(describe(gate, toStandingAnswer(await settings.get<unknown>(gate))));
          yield { type: 'result', value: { answers } };
          return;
        }

        if (act.action === 'clear') {
          if (act.subject !== undefined) {
            if (act.gate === undefined) {
              yield { type: 'error', message: 'clear: "subject" identifies a subject WITHIN a gate — pass "gate" as well, or omit "subject" to clear the whole gate.' };
              return;
            }
            const current = toStandingAnswer(await settings.get<unknown>(act.gate));
            if (current === undefined || current === true) {
              // `true` allows every subject, so there is no one subject to subtract — saying so beats
              // silently writing a list that would then shadow the blanket answer the user gave.
              yield { type: 'result', value: { cleared: [], message: current === true
                ? `"${act.gate}" is allowed for every subject — clear the gate itself to undo that.`
                : `"${act.gate}" has no standing answer, so nothing was cleared.` } };
              return;
            }
            const remaining = current.filter(s => s !== act.subject);
            if (remaining.length === current.length) {
              yield { type: 'result', value: { cleared: [], message: `"${act.subject}" is not a remembered subject of "${act.gate}".` } };
              return;
            }
            // An empty list is stored rather than deleted: it means "ask about everything", which is a
            // different fact from "revert to whatever the installation configured".
            await settings.set(act.gate, remaining);
            yield { type: 'result', value: { cleared: [`${act.gate}:${act.subject}`], message:
              `"${act.gate}" will ask about "${act.subject}" again.` } };
            return;
          }

          const ids     = act.gate !== undefined ? [act.gate] : await gateIds();
          const cleared: string[] = [];
          for (const gate of ids) {
            if (toStandingAnswer(await settings.get<unknown>(gate)) === undefined) continue;
            await settings.delete(gate);
            cleared.push(gate);
          }
          yield { type: 'result', value: { cleared, message: cleared.length === 0
            ? 'No standing answers were stored, so nothing was cleared.'
            : `Forgot ${cleared.length} standing answer(s): ${cleared.join(', ')}. Each reverts to whatever this installation configured — which may itself allow the operation.` } };
          return;
        }

        yield { type: 'error', message: `Unknown action "${String((act as { action: unknown }).action)}" — expected "get" or "clear".` };
      },
    },
  };
}
