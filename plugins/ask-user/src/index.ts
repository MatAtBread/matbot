import type { Tool, ToolExecutor, ToolContract, ToolResultOf, ToolContext, MatbotPluginSpec, FormField } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // `answer` is the user's reply: the typed text, the chosen option, or "Yes"/"No" for a confirm.
    ask_user: ToolContract<{ name: string; answer: string }, { name: string; label: string; type: 'text' | 'password' | 'select' | 'confirm'; options?: string[]; allowOther?: boolean; default?: string; required?: boolean; cancelable?: boolean }>;
  }
}

const MAX_OPTIONS = 10;
const VALID_TYPES: FormField['type'][] = ['text', 'password', 'select', 'confirm'];

const executor: ToolExecutor<ToolResultOf<'ask_user'>> = {
  async *execute(input: unknown, ctx: ToolContext) {
    const field = input as FormField;

    if (!field.name || typeof field.name !== 'string') {
      yield { type: 'error', message: 'Missing required field "name" (string).' };
      return;
    }
    if (!field.label || typeof field.label !== 'string') {
      yield { type: 'error', message: 'Missing required field "label" (string).' };
      return;
    }
    if (!(VALID_TYPES as readonly string[]).includes(field.type)) {
      yield { type: 'error', message: `Invalid type "${field.type}"; must be one of: ${VALID_TYPES.join(', ')}.` };
      return;
    }
    if (field.type === 'select') {
      if (!Array.isArray(field.options) || field.options.length === 0) {
        yield { type: 'error', message: 'type "select" requires a non-empty "options" array.' };
        return;
      }
      if (field.options.length > MAX_OPTIONS) {
        yield { type: 'error', message: `Too many options (${field.options.length}); maximum is ${MAX_OPTIONS}.` };
        return;
      }
    }

    try {
      const answer = await ctx.prompt(field);
      yield { type: 'result', value: { name: field.name, answer } };
    } catch (e) {
      yield { type: 'error', message: String(e) };
    }
  },
};

export const askUserTool: Tool<ToolResultOf<'ask_user'>> = {
  name: 'ask_user',
  description: `Use this tool when you need the user to choose, confirm, or supply a value
   before proceeding. The frontend renders the question as an interactive control.

## Input contract
\`\`\`typescript
interface FormField {
  name:        string;   // machine-readable key for the response
  label:       string;   // the question text shown to the user
  type:        'text' | 'password' | 'select' | 'confirm';
  options?:    string[]; // required when type is 'select' — mutually exclusive choices
  allowOther?: boolean;  // select-only: also let the user type a free-form answer
  default?:    string;   // pre-filled or pre-selected value
  required?:   boolean;  // if true, user must supply a non-empty value
  cancelable?: boolean;  // default true; set false to forbid cancelling (see below)
}
\`\`\`

## Field types

- **text** — free-form text input. Use for open-ended questions.
- **password** — masked text input. Use for secrets, API keys, tokens (the value is not displayed).
- **select** — mutually exclusive pick from \`options\`. Use for multiple-choice questions. The frontend renders options as buttons or a dropdown. Set \`allowOther: true\` to also offer a free-text answer when your options may not cover every case.
- **confirm** — yes/no confirmation. Use for irreversible actions. The frontend renders as a confirm/cancel dialog. Returns "Yes" or "No".

## Declining vs cancelling

These are different and you should design for the first one. If the user might legitimately say "no thanks", "skip", or "I don't know", offer that as one of your \`options\` (or a \`confirm\`) — you get the choice back as a normal answer and branch on it. Only omit such an option when an answer is genuinely required (e.g. a password with no fallback).

\`cancelable\` is unrelated: it controls whether the frontend shows a "give up entirely" affordance. Cancelling is not an answer — it abandons the whole operation and returns control to the user, and this tool reports it as an error. Leave \`cancelable\` at its default (true); set it false only for a prompt the user must not be able to escape.

## Examples

\`\`\`json
// Multiple-choice question (4 mutually exclusive options)
{
  "name": "skill",
  "label": "If you could instantly master any skill, which would you choose?",
  "type": "select",
  "options": [
    "Playing a musical instrument fluently",
    "Speaking every language in the world",
    "Expert-level coding and software development",
    "Painting or drawing with professional skill"
  ]
}

// Confirmation before a destructive action
{
  "name": "confirmed",
  "label": "Delete all records for project X?",
  "type": "confirm"
}

// Ask for a password or API key
{
  "name": "token",
  "label": "Enter your GitHub personal access token:",
  "type": "password",
  "required": true
}

// Open-ended question
{
  "name": "title",
  "label": "What should the report be titled?",
  "type": "text",
  "default": "Q4 Summary"
}
\`\`\``,

  inputSchema: {
    type: 'object',
    required: ['name', 'label', 'type'],
    properties: {
      name:     { type: 'string', description: 'Machine-readable key for the response value.' },
      label:    { type: 'string', description: 'The question text shown to the user.' },
      type:     { type: 'string', enum: ['text', 'password', 'select', 'confirm'], description: 'Control type: text (free text), password (masked), select (multiple choice from options), confirm (yes/no).' },
      options:    { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_OPTIONS, description: 'Mutually exclusive options. Required when type is "select".' },
      allowOther: { type: 'boolean', description: 'select-only: also let the user type a free-form answer alongside the options.' },
      default:    { type: 'string', description: 'Pre-filled or pre-selected value.' },
      required:   { type: 'boolean', description: 'If true, user must supply a non-empty value.' },
      cancelable: { type: 'boolean', description: 'Default true. Set false to forbid cancelling — a graceful "decline" should be an option/confirm value, not a cancel.' },
    },
  },
  executor,
};

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [askUserTool],
};
