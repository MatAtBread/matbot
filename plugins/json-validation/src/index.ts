import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, JSONSchema } from '@matatbread/matbot-plugin-api';
// Type-only: it brings the `MatbotServices.ToolCallValidator` augmentation, which core declares because
// core is what consults it (at the executor, so every door is covered rather than only the model's).
import type { MatbotMachine } from '@matatbread/matbot-plugin-api';
import type { ToolInputValidator } from '@matatbread/matbot-core';

/** Structural, not imported: matches what core's `ToolInputValidator` expects back. Paths are DOTTED
 *  (`.items[0].name`) so this validator and the typed one read identically to whoever gets the error,
 *  and `value` is what was actually supplied — core renders it, and omits it when absent. */
interface ValidationError { path: string; message: string; value?: unknown }

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

function validate(schema: JSONSchema, value: unknown, path: string, errs: ValidationError[]): void {
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

    for (const key of required) {
      // No `value`: a missing property has none, and JSON cannot carry `undefined` to show.
      if (!(key in obj)) errs.push({ path: `${path}${propPath(key)}`, message: 'required property missing' });
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

// Registered as core's `ToolCallValidator` rather than installed as a `toolcall` hook. The hook was a
// RUNNER channel, so it guarded the model's path and nothing else: `POST /tools/:name` and `invokeTool`
// both call `tool.executor.execute` directly and fire no hooks. Core now consults this at the executor,
// which is the one place all three doors already pass through — so there is one check instead of one per
// door, and nothing to drift.
function makeValidator(services: MatbotMachine): ToolInputValidator {
  const reported = new Set<string>();
  // Whatever was registered before us. A validator that displaces another delegates to it when it has
  // nothing to say, so the typed validator (contracts) and this one (schemas) compose in either load
  // order instead of shadowing each other.
  const previous = services.ToolCallValidator;

  return {
    async validateToolCall(name, parameters) {
      const tool = services.tools.resolve(name);
      // No such tool, or nothing to validate against: NO OPINION, never "valid".
      if (!tool) return previous?.validateToolCall(name, parameters);

      if (!reported.has(name)) {
        reported.add(name);
        const unvalidated = new Map<string, string>();
        findUnvalidated(tool.inputSchema, '', unvalidated);
        if (unvalidated.size > 0) {
          const list = [...unvalidated].map(([kw, at]) => `${kw} (at ${at})`).join(', ');
          console.warn(`[json-validation] Tool "${name}" schema uses keyword(s) this validator does not check: ${list}. Inputs exercising these are passed through unvalidated.`);
        }
      }

      const errs: ValidationError[] = [];
      validate(tool.inputSchema, parameters, '', errs);
      // A clean pass here is weak evidence — this validator is deliberately minimal — so defer to a
      // predecessor that may know more (a typed contract) before reporting "valid".
      if (errs.length === 0) return await previous?.validateToolCall(name, parameters) ?? [];
      return errs;
    },
  };
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    await services.register('ToolCallValidator', makeValidator(services));
  },
};
