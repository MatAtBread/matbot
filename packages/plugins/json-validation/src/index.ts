import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPlugin, Hook, ToolHookContext, JSONSchema } from '@matatbread/matbot-plugin-api';

// A deliberately small JSON Schema validator covering the subset matbot tool
// inputSchemas use: type, properties, required, items, enum, additionalProperties,
// pattern. Unknown keywords are ignored (standard JSON Schema semantics) and
// unrecognised types pass — so this can never reject more than it understands.

// Keywords this validator actually enforces.
const ENFORCED = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'pattern',
]);
// Keywords that carry no validation semantics — safe to ignore without warning.
const ANNOTATIONS = new Set([
  'description', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  '$schema', '$id', '$comment', 'definitions', '$defs',
]);

// Walk a schema tree and collect every keyword that affects validation but this
// validator doesn't enforce (anyOf, $ref, minimum, format, …) → reported so an
// overreaching tool schema is visible rather than silently passed through.
function findUnvalidated(schema: JSONSchema, path: string, found: Map<string, string>): void {
  for (const key of Object.keys(schema)) {
    if (!ENFORCED.has(key) && !ANNOTATIONS.has(key) && !found.has(key)) {
      found.set(key, path || '/');
    }
  }
  const props = schema['properties'];
  if (props && typeof props === 'object') {
    for (const [k, v] of Object.entries(props)) {
      if (v && typeof v === 'object') findUnvalidated(v as JSONSchema, `${path}/${k}`, found);
    }
  }
  const items = schema['items'];
  if (items && typeof items === 'object') findUnvalidated(items as JSONSchema, `${path}/[]`, found);
  const additional = schema['additionalProperties'];
  if (additional && typeof additional === 'object') findUnvalidated(additional as JSONSchema, `${path}/*`, found);
}

function matches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':  return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number':  return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'object':  return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':   return Array.isArray(value);
    case 'null':    return value === null;
    default:        return true;
  }
}

function validate(schema: JSONSchema, value: unknown, path: string, errs: string[]): void {
  const at = path || '/';
  const type = schema['type'];

  if (typeof type === 'string' && !matches(type, value)) {
    errs.push(`${at}: expected ${type}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
    return;
  }
  if (Array.isArray(type) && !type.some(t => typeof t === 'string' && matches(t, value))) {
    errs.push(`${at}: expected one of ${type.join(', ')}`);
    return;
  }

  const enumVals = schema['enum'];
  if (Array.isArray(enumVals) && !enumVals.some(e => e === value || JSON.stringify(e) === JSON.stringify(value))) {
    errs.push(`${at}: must be one of ${enumVals.map(e => JSON.stringify(e)).join(', ')}`);
  }

  const pattern = schema['pattern'];
  if (typeof pattern === 'string' && typeof value === 'string' && !new RegExp(pattern).test(value)) {
    errs.push(`${at}: does not match pattern ${pattern}`);
  }

  if (matches('object', value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema['properties'] ?? {}) as Record<string, JSONSchema>;
    const required = Array.isArray(schema['required']) ? schema['required'] as string[] : [];
    const additional = schema['additionalProperties'];

    for (const key of required) {
      if (!(key in obj)) errs.push(`${path}/${key}: required property missing`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) validate(props[key], v, `${path}/${key}`, errs);
      else if (additional === false) errs.push(`${path}/${key}: unexpected property`);
      else if (typeof additional === 'object' && additional !== null) {
        validate(additional as JSONSchema, v, `${path}/${key}`, errs);
      }
    }
  }

  const items = schema['items'];
  if (Array.isArray(value) && typeof items === 'object' && items !== null) {
    value.forEach((v, i) => validate(items as JSONSchema, v, `${path}/${i}`, errs));
  }
}

function makeValidatorHook(): Hook<ToolHookContext> {
  const reported = new Set<string>();

  return {
    point:      'before:tool',
    pluginName: '@matatbread/matbot-tool-json-validation',
    async handler(ctx) {
      const { tool, toolCall } = ctx;

      if (!reported.has(tool.name)) {
        reported.add(tool.name);
        const unvalidated = new Map<string, string>();
        findUnvalidated(tool.inputSchema, '', unvalidated);
        if (unvalidated.size > 0) {
          const list = [...unvalidated].map(([kw, at]) => `${kw} (at ${at})`).join(', ');
          console.warn(`[json-validation] Tool "${tool.name}" schema uses keyword(s) this validator does not check: ${list}. Inputs exercising these are passed through unvalidated.`);
        }
      }

      const errs: string[] = [];
      validate(tool.inputSchema, toolCall.input, '', errs);
      if (errs.length === 0) return;

      ctx.rejectTool = { message: `Invalid input for tool "${toolCall.name}": ${errs.join('; ')}` };
      return ctx;
    },
  };
}

export const plugin: MatbotPlugin = {
  name:       '@matatbread/matbot-tool-json-validation',
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Validates tool-call inputs against each tool\'s JSON Schema, returning an error result on mismatch so the model can self-correct.',
  },

  async setup(services) {
    services.hooks.register(makeValidatorHook());
  },
};
