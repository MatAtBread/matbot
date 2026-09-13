import type { PluginSettings, Tool, ToolContract, ToolResultOf } from '@matatbread/matbot-plugin-api';
import { DEFAULT_GATE_SETTINGS_NS, toStandingAnswer, type StandingAnswer } from './gate.js';

/** A standing answer in force for one gate: `always` allows every subject, `subjects` allows exactly
 *  those. There is no arm for "no answer" — a gate with none simply is not reported, because an absent
 *  key says nothing about the behaviour. It is not "this will ask": what happens then is the call
 *  site's `fallback` when nobody is reachable, and whatever policy is registered when someone is.
 *  Reporting a row there would be inventing a fact.
 *
 *  What is *in effect*, never what is pinned — a stored answer and an installation's
 *  `default_settings:` floor read identically, because the question a caller has is "will this prompt
 *  appear?" and the two are the same answer to it. */
export interface GateAnswer {
  gate:      string;
  effect:    'always' | 'subjects';
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

// An empty stored list is still an ANSWER — "ask about every subject of this gate" — and is reported
// as such, because it is a thing someone did (cleared the last subject) and a thing `clear` can undo
// back to the installation's configured default. Absent is what goes unreported.
const describe = (gate: string, answer: StandingAnswer | undefined): GateAnswer | undefined =>
  answer === true      ? { gate, effect: 'always' }
  : answer === undefined ? undefined
  :                        { gate, effect: 'subjects', subjects: answer };

export function makeGateActionTool(settings: PluginSettings): Tool<ToolResultOf<'gate_action'>> {
  // Every standing answer in force, in ONE document read: `entries()` layers the stored document over
  // the installation's configured defaults exactly as `get` does, so an answer an install SHIPPED is
  // listed beside one someone gave at a prompt — which no index of "what this code wrote" could ever
  // see. A value that is not a standing answer is simply not one (toStandingAnswer returns undefined),
  // so a stray key in the namespace is never reported as a permission.
  const standing = async (): Promise<Map<string, StandingAnswer>> => {
    const found = new Map<string, StandingAnswer>();
    for (const [gate, value] of Object.entries(await settings.entries())) {
      const answer = toStandingAnswer(value);
      if (answer !== undefined) found.set(gate, answer);
    }
    return found;
  };

  return {
    name: 'gate_action',
    description:
      'Inspect and forget the standing answers this installation\'s permission policy remembers.\n\n' +
      'A privileged operation — installing a plugin, adding a provider profile, overwriting a tool ' +
      'another plugin owns — asks the user to accept it. Answering "Always allow …" at that prompt ' +
      'stores a standing answer, after which the same operation proceeds silently.\n\n' +
      '"get" reports the standing answers IN EFFECT — which may come from one of those prompts or from ' +
      'the installation\'s configured defaults; the two are indistinguishable here on purpose, because ' +
      'the question is whether the prompt will appear. A gate with no answer is NOT reported: on a ' +
      'fresh install the list is empty, and every gate simply behaves as configured (normally: it ' +
      'asks). Gate ids are open — a plugin contributes its own — so there is no vocabulary to list. ' +
      'Pass "gate" to ask about one id, including one an installation configured but nobody has ' +
      'answered, which a bare listing cannot reach.\n\n' +
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
          const held    = await standing();
          const ids     = act.gate !== undefined ? [act.gate] : [...held.keys()];
          const answers = ids.map(gate => describe(gate, held.get(gate)))
                             .filter((row): row is GateAnswer => row !== undefined);
          yield { type: 'result', value: { answers } };
          return;
        }

        if (act.action === 'clear') {
          if (act.subject !== undefined) {
            if (act.gate === undefined) {
              yield { type: 'error', message: 'clear: "subject" identifies a subject WITHIN a gate — pass "gate" as well, or omit "subject" to clear the whole gate.' };
              return;
            }
            const current = (await standing()).get(act.gate);
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
            // Stored, not deleted — including when the list came from `default_settings:`: the result
            // is an override that keeps the rest of the configured list and drops this one subject,
            // which is what was asked for. An empty list is stored too; it means "ask about every
            // subject", a different fact from "revert to whatever the installation configured".
            await settings.set(act.gate, remaining);
            yield { type: 'result', value: { cleared: [`${act.gate}:${act.subject}`], message:
              `"${act.gate}" will ask about "${act.subject}" again.` } };
            return;
          }

          const before = await standing();
          const ids    = act.gate !== undefined ? [act.gate] : [...before.keys()];
          for (const gate of ids) {
            if (before.has(gate)) await settings.delete(gate);
          }
          // What `delete` does is REVERT to the installation's configured default, which for a gate
          // answered only in `default_settings:` is no change at all — there was nothing stored to
          // remove. Reporting those as cleared was a list that looked like a success and wasn't, so the
          // outcome is read back (one document read) and the answer is compared: what CHANGED is what
          // was forgotten, and what is still in force afterwards is named separately, because that part
          // lives in config and this tool cannot touch it.
          const after   = await standing();
          const same    = (a: StandingAnswer | undefined, b: StandingAnswer | undefined): boolean =>
            JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
          const cleared = ids.filter(gate => !same(before.get(gate), after.get(gate)));
          const stayed  = ids.filter(gate => after.has(gate));
          const parts: string[] = [];
          if (cleared.length > 0) parts.push(`Forgot ${cleared.length} standing answer(s): ${cleared.join(', ')} — each now behaves as this installation configured it.`);
          if (stayed.length > 0)  parts.push(`Still allowed by the installation's configured defaults, which this tool cannot change: ${stayed.join(', ')}. Edit \`default_settings\` for '${DEFAULT_GATE_SETTINGS_NS}' to change those.`);
          if (parts.length === 0) parts.push('No standing answers were stored, so nothing was cleared.');
          yield { type: 'result', value: { cleared, message: parts.join(' ') } };
          return;
        }

        yield { type: 'error', message: `Unknown action "${String((act as { action: unknown }).action)}" — expected "get" or "clear".` };
      },
    },
  };
}
