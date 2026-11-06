import type { FormField, PromptFn }    from '@matatbread/matbot-core';
import { CONFIRM_YES, CONFIRM_NO }      from '@matatbread/matbot-core';
import type { Interface }               from 'node:readline/promises';
import process                          from 'node:process';
import { answerSelect, renderSelect }   from './select.js';

export const isBackground = process.env.IS_SUB_AGENT === '1';

// Prefixed to output so parent and spawned background processes are distinguishable in a shared terminal.
export const stamp = (): string => `[${new Date().toISOString()} ${process.pid}]`;

// Colour only when writing to an interactive terminal — piped/background output stays clean. The two
// streams are asked separately because they carry different things: the assistant's answer is the only
// thing on stdout (so it survives a pipe uncoloured), everything else is stderr.
const ttyErr = !isBackground && process.stderr.isTTY === true;
const ttyOut = !isBackground && process.stdout.isTTY === true;
// Whitespace-only text is left alone so a bare newline doesn't carry a pair of escapes.
const paint = (on: boolean, code: string) => (s: string): string =>
  (on && s.trim() !== '' ? `\x1b[${code}m${s}\x1b[0m` : s);

export const yellow  = paint(ttyErr, '33');   // tools, thinking, markers, accounting — the machinery
export const dim     = paint(ttyErr, '2');
export const cyanErr = paint(ttyErr, '36');   // the assistant, on the stderr side (its label)
export const cyanOut = paint(ttyOut, '36');   // the assistant's own words

// Everything written through `write` is harness chatter, hence yellow.
export const write = isBackground ? (_text: string) => {} : (text: string) => process.stderr.write(yellow(text));

// A prompt is chatter, but the line the user types back is theirs: leave the colour OPEN past the
// prompt so readline's echo is white, and close it once the answer is in. Node measures prompt width
// with ANSI stripped, so the trailing escape doesn't upset wrapping.
export const askPrompt = (prompt: string): string => (ttyErr ? `\x1b[33m${prompt}\x1b[0m\x1b[37m` : prompt);
export const endInput  = (): void => { if (ttyErr) process.stderr.write('\x1b[0m'); };

export function installConsolePrefix(): void {
  // Every level that writes, not just the three in common use: an unwrapped `console.debug` (the plugin
  // loader's cache-bust notes) went straight to stdout, unprefixed and unsuppressed — and a background
  // job's stdout IS its output file, so the notes landed in the user's result.
  for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
    const orig = console[level].bind(console) as (...a: unknown[]) => void;
    console[level] = (label, ...args: unknown[]) => {
      if (isBackground && level !== 'error') return;
      // Diagnostics are harness chatter: open yellow on the prefix and close it as a trailing argument,
      // so any object args in between are still coloured rather than only the first one.
      const on = level === 'warn' || level === 'error' ? ttyErr : ttyOut;
      if (on) orig(`\x1b[33m${stamp()} ${label}`, ...args, '\x1b[0m');
      else    orig(`${stamp()} ${label}`, ...args);
    };
  }
}

/** Questions put at the terminal over `rl`: `ask` for a line, `prompt` for a tool's `PromptFn`. */
export function terminalPrompt(rl: Interface): { ask: (prompt: string) => Promise<string>; prompt: PromptFn } {
  // Every read goes through here so the answer's colour is always closed, including on a throw.
  const ask = async (prompt: string): Promise<string> => {
    try { return await rl.question(askPrompt(prompt)); } finally { endInput(); }
  };

  const prompt = (async (p: string | FormField, defaultValue?: string): Promise<string> => {
    if (typeof p !== 'string') {
      const def = p.default;
      if (p.type === 'select' || p.type === 'confirm') {
        const opts = p.type === 'confirm' ? [CONFIRM_YES, CONFIRM_NO] : (p.options ?? []);
        // Typed against what was SHOWN, answered with the VALUE (it is what the caller branches on). For
        // a bare-string option the two are the same, which is every option in the repo bar the permission
        // gate's — so this is one indirection, not a new mode. Rendering and resolving live together in
        // `select.ts`, because the two must agree on the addressing scheme: prose labels that share a long
        // prefix made the middle options of a gate prompt untypeable. What was SHOWN is the only addressing
        // scheme the reader has, which is why `numbered` is passed back.
        const { lines, hint, numbered } = renderSelect(opts, def);
        for (let attempt = 0; ; attempt++) {
          if (lines.length > 0) for (const l of lines) process.stderr.write(`${l}\n`);
          const raw = await ask(`${p.label} [${hint}] `);
          const outcome = answerSelect(opts, raw, {
            numbered, again: attempt > 0,
            ...(def !== undefined        ? { def }             : {}),
            ...(p.allowOther === true    ? { allowOther: true } : {}),
          });
          if ('answer' in outcome) return outcome.answer;
          process.stderr.write(yellow(outcome.retry));
        }
      }
      const suffix = def !== undefined ? ` [${def}] ` : ' ';
      return (await ask(`${p.label}${suffix}`)).trim() || def || '';
    }
    const suffix = defaultValue !== undefined ? ` [${defaultValue}] ` : ' ';
    const answer = await ask(`${p}${suffix}`);
    return answer.trim() || defaultValue || '';
  }) as PromptFn;

  return { ask, prompt };
}
