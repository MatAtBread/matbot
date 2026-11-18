import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, JSONSchema, ToolInputError } from '@matatbread/matbot-plugin-api';

// Errors' paths are DOTTED (`.items[0].name`) so this validator and the typed one read identically to
// whoever gets the error, and `value` is what was actually supplied — core renders it, and omits it when
// absent.

/** `.name` for an identifier-shaped key, `["odd key"]` otherwise — the access a caller would write. */
const propPath = (k: string): string => /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;

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

function validate(schema: JSONSchema, value: unknown, path: string, errs: ToolInputError[]): void {
  const at = path || '.';
  const type = schema['type'];

  if (typeof type === 'string' && !matches(type, value)) {
    errs.push({ path: at, message: `expected ${type}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`, value });
    return;
  }
  if (Array.isArray(type) && !type.some(t => typeof t === 'string' && matches(t, value))) {
    errs.push({ path: at, message: `expected one of ${type.join(', ')}`, value });
    return;
  }

  const enumVals = schema['enum'];
  if (Array.isArray(enumVals) && !enumVals.some(e => e === value || JSON.stringify(e) === JSON.stringify(value))) {
    errs.push({ path: at, message: `must be one of ${enumVals.map(e => JSON.stringify(e)).join(', ')}`, value });
  }

  const pattern = schema['pattern'];
  if (typeof pattern === 'string' && typeof value === 'string' && !new RegExp(pattern).test(value)) {
    errs.push({ path: at, message: `does not match pattern ${pattern}`, value });
  }

  if (matches('object', value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema['properties'] ?? {}) as Record<string, JSONSchema>;
    const required = Array.isArray(schema['required']) ? schema['required'] as string[] : [];
    const additional = schema['additionalProperties'];

    const missing = required.filter(key => !(key in obj));
    // A schema that leaves `additionalProperties` unset admits undeclared keys, so they are never a
    // rejection on their own. But once the call is being refused anyway, an undeclared key is the likelier
    // cause — an `action` sent to a tool that has none reads as "prompt missing" otherwise — so it is
    // named first. Reported only alongside a refusal, this can never reject a call the schema admits.
    // Worded exactly as ts-validation words the same key: the hook merge says an error once by path and
    // message, so different words for one fault reported it twice, each with its own copy of the value.
    if (missing.length && additional === undefined && schema['properties'] !== undefined) {
      for (const [key, v] of Object.entries(obj)) {
        if (!props[key]) errs.push({ path: `${path}${propPath(key)}`, message: 'unexpected property', value: v });
      }
    }
    for (const key of missing) {
      // No `value`: a missing property has none, and JSON cannot carry `undefined` to show.
      errs.push({ path: `${path}${propPath(key)}`, message: 'required property missing' });
    }
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) validate(props[key], v, `${path}${propPath(key)}`, errs);
      else if (additional === false) errs.push({ path: `${path}${propPath(key)}`, message: 'unexpected property', value: v });
      else if (typeof additional === 'object' && additional !== null) {
        validate(additional as JSONSchema, v, `${path}${propPath(key)}`, errs);
      }
    }
  }

  const items = schema['items'];
  if (Array.isArray(value) && typeof items === 'object' && items !== null) {
    value.forEach((v, i) => validate(items as JSONSchema, v, `${path}[${i}]`, errs));
  }
}

// A `validate` hook, which core dispatches at the executor — the one place every door (the runner,
// `POST /tools/:name`, `invokeTool`) passes through. Not a `toolcall` hook: that is a RUNNER channel and
// guards the model's path alone. Beside `ts-validation` with no reference to it: a call is refused if
// either refuses it, so a clean pass here never stands in for a typed contract it knows nothing about.
function makeValidator(services: MatbotMachine): (name: string, parameters: unknown) => ToolInputError[] | undefined {
  const reported = new Set<string>();

  return (name, parameters) => {
    const tool = services.tools.resolve(name);
    // No such tool: NO OPINION, never "valid".
    if (!tool) return undefined;

    if (!reported.has(name)) {
      reported.add(name);
      const unvalidated = new Map<string, string>();
      findUnvalidated(tool.inputSchema, '', unvalidated);
      if (unvalidated.size > 0) {
        const list = [...unvalidated].map(([kw, at]) => `${kw} (at ${at})`).join(', ');
        console.warn(`[json-validation] Tool "${name}" schema uses keyword(s) this validator does not check: ${list}. Inputs exercising these are passed through unvalidated.`);
      }
    }

    const errs: ToolInputError[] = [];
    validate(tool.inputSchema, parameters, '', errs);
    return errs;
  };
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    const judge = makeValidator(services);
    services.hooks.register({ on: 'validate', handler: ctx => judge(ctx.tool, ctx.parameters) });
  },
};
