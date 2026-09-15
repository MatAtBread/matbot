import type { FunctionRunner, JSONSchema, TypeScriptStripper } from '@matatbread/matbot-plugin-api';
import { INJECTED, type CompiledFn } from './compile.js';
import { inertEnd, matchBrace, matchParen, parseSignature, tsTypeToSchema, type ParsedParam } from './signature.js';

/** The separator between a package name and an export's name in the registered tool name. Not `.`, which
 *  Anthropic and OpenAI reject in a tool name, and not `-`, which is not an identifier character: the name
 *  the model sees, repeats in prose and calls over HTTP is exactly the one code dereferences as
 *  `tool.MyPkg__my_tool`, so there is no second spelling to encode or leak. */
export const PACKAGE_SEPARATOR = '__';

/** The tool-name limit the strictest provider imposes; a longer combined name would 400 every turn. */
const MAX_TOOL_NAME = 64;

export interface PackageExport {
  name:        string;
  toolName:    string;
  description?: string;
  /** The exported function's own source, without `export` — the fallback description. */
  source:      string;
  param?:      ParsedParam;
  resultType:  string;
  inputSchema: JSONSchema;
  toolContract: string;
}

export interface ParsedPackage {
  exports: PackageExport[];
  /** Offsets of each top-level `export` keyword, blanked out before compiling. */
  exportAt: number[];
}

export type PackageFn = (tool: unknown, toolInContext: unknown, context: unknown, exportName: string, arg: unknown) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor as
  new (...names: string[]) => PackageFn;

const IDENT_CHAR = /[\w$]/;

/** Said in every refusal, because the mistake it corrects is a reasonable reading of module syntax. */
export const STATELESS =
  'A package exists only to keep private helpers out of the global tool scope; it is not a substitute for a ' +
  'plugin, and it keeps NO state: its top level is evaluated afresh on every tool call, so nothing there persists ' +
  'between calls or runs once. Keep per-call values inside the function that uses them. Anything needing state, ' +
  'a cache, one-time setup, hooks or background work is a matbot plugin, not a package.';

// An inclusion list. `export` is passed through to parsePackage, which admits only exported functions.
const DECLARATION = /^(?:export|(?:async\s+)?function[\s*]|const\s|interface\s|type\s)/;
const ALLOWED = '`function`, `async function`, `export function`, `export async function`, `const`, `interface` and `type`';

// The near-misses, each refused for a reason of its own rather than only for not being on the list.
const REFUSED: Record<string, string> = {
  let:      'a top-level `let` is re-created on every tool call, so its value never persists between calls',
  var:      'a top-level `var` is re-created on every tool call, so its value never persists between calls',
  import:   'a package cannot `import` — its functions run with only `tool`, `toolInContext` and `context` in scope',
  declare:  'a `declare` names something that does not exist at runtime, so it would pass the type-check and then throw a ReferenceError',
  enum:     'an `enum` is not erasable TypeScript — use a `const` object or a union `type`',
  class:    'a `class` invites instance or static state, which a package cannot keep — use a function returning an object',
  abstract: 'a `class` invites instance or static state, which a package cannot keep — use a function returning an object',
};

function assertStatement(source: string, at: number): void {
  const head = (source.slice(at, at + 80).split('\n')[0] ?? '').trim();
  const word = /^[A-Za-z_$][\w$]*/.exec(head)?.[0];
  const reason = word !== undefined ? REFUSED[word] : undefined;
  if (reason !== undefined) throw new Error(`\`${head}\` is not allowed in a package: ${reason}. Only ${ALLOWED} may appear at the top level. ${STATELESS}`);
  if (DECLARATION.test(head)) return;
  throw new Error(`top-level statement \`${head}\` is not allowed in a package — it would run again on every tool call, not once. Only ${ALLOWED} may appear at the top level. ${STATELESS}`);
}

/**
 * Refuse what would behave differently if the top level ran once rather than per call — `let`/`var`,
 * a bare statement, a top-level `await` — so that how often it runs is unobservable, and an author who
 * reads the source as a module is told so instead of silently losing state. `const` stays: documenting a
 * magic value is its common use, and `const state = {}` is a knowingly accepted escape.
 *
 * A scan, not a parse — this runs where there is no TypeScript compiler. It does not look for where a
 * statement STARTS: with optional semicolons, punctuation cannot say (`const a = 1\nlet n = 0` has none to
 * find). Instead each allowed declaration is walked to where it ENDS and the next thing must be another. A
 * `function` or `interface` ends at its body's `}`, so whatever follows is a new statement, `(` included. A
 * `const` or `type` ends at a top-level `;`, or at a line break where ASI would end it: the token before
 * can end an expression and the token after cannot continue one.
 */
function assertStatelessTopLevel(source: string): void {
  let at = nextSignificant(source, 0);
  while (at !== -1) at = nextSignificant(source, declarationEnd(source, at) + 1);
}

const headLine = (s: string, at: number): string => (s.slice(at, at + 80).split('\n')[0] ?? '').trim();

function declarationEnd(s: string, at: number): number {
  assertStatement(s, at);
  const head = /^export\b/.test(s.slice(at, at + 7)) ? nextSignificant(s, at + 6) : at;
  if (head === -1) return s.length - 1;
  const rest = s.slice(head, head + 20);
  const end = /^(?:async\s+)?function\b/.test(rest) ? functionDeclarationEnd(s, head)
    : /^interface\b/.test(rest) ? interfaceEnd(s, head)
    : initializerEnd(s, head, /^type\b/.test(rest));
  if (end === -1) throw new Error(`could not find the end of \`${headLine(s, at)}\` — check that its brackets balance.`);
  return end;
}

/** Past a `<…>` type-parameter list starting at `i`, to the next significant character; `i` if there is none. */
function skipTypeParams(s: string, i: number): number {
  if (s[i] !== '<') return i;
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const inert = inertEnd(s, k);
    if (inert >= 0) { k = inert; continue; }
    if (s[k] === '=' && s[k + 1] === '>') { k++; continue; }
    if (s[k] === '<') depth++;
    else if (s[k] === '>' && --depth === 0) return nextSignificant(s, k + 1);
  }
  return -1;
}

function functionDeclarationEnd(s: string, head: number): number {
  const name = /^(?:async\s+)?function\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*/.exec(s.slice(head));
  if (name === null) return -1;
  const open = skipTypeParams(s, head + name[0].length);
  return s[open] === '(' ? functionEnd(s, open, true) : -1;
}

function interfaceEnd(s: string, head: number): number {
  let angle = 0;
  for (let i = head; i < s.length; i++) {
    const inert = inertEnd(s, i);
    if (inert >= 0) { i = inert; continue; }
    const c = s[i];
    if (c === '=' && s[i + 1] === '>') { i++; continue; }
    if (c === '<') angle++;
    else if (c === '>') angle--;
    else if (c === '{') {
      const end = matchBrace(s, i);
      if (angle === 0 || end === -1) return end;
      i = end;
    }
  }
  return -1;
}

// Words that carry an expression or type onto the next line when they open it…
const CONTINUES_LINE = new Set(['as', 'satisfies', 'in', 'instanceof', 'extends', 'is']);
// …and those that leave one unfinished when they end a line. `new` is only the second: a line opening with
// it after a complete expression is a new statement, which is exactly the case to catch.
const UNFINISHED_AT_EOL = new Set([...CONTINUES_LINE, 'keyof', 'typeof', 'infer', 'readonly', 'unique', 'new', 'void', 'delete', 'await']);

function continuesLine(s: string, i: number): boolean {
  if (/[.,([`+\-*/%&|^<>=?:]/.test(s[i] as string)) return true;
  const word = /^[A-Za-z_$][\w$]*/.exec(s.slice(i))?.[0];
  return word !== undefined && CONTINUES_LINE.has(word);
}

/** The last character of a `const`/`type` (or other non-function) declaration starting at `head`. */
function initializerEnd(s: string, head: number, isType: boolean): number {
  let depth = 0;
  let angle = 0;
  // `<`/`>` are brackets in a type — a whole `type`, or a `const`'s annotation — and operators in an initializer.
  let typed = isType;
  let assigned = false;
  // An expression-bodied arrow's `await` belongs to the arrow, not the top level.
  let arrow = false;
  let ended = false;
  let broke = false;
  let last = head;
  for (let i = head; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '\n') { if (depth === 0 && angle === 0) broke = true; continue; }
    if (/\s/.test(c)) continue;
    const inert = inertEnd(s, i);
    if (inert >= 0 && c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      if (depth === 0 && angle === 0 && s.slice(i, inert + 1).includes('\n')) broke = true;
      i = inert;
      continue;
    }
    if (depth === 0 && angle === 0) {
      if (broke && ended && !continuesLine(s, i)) return last;
      if (c === ';') return i;
      if (!arrow && /^await\b/.test(s.slice(i, i + 6)) && !IDENT_CHAR.test(s[i - 1] ?? '')) {
        throw new Error(`top-level \`await\` is not allowed in a package (\`${headLine(s, i)}\`) — it would repeat on every tool call rather than load once. Await inside the function that needs the value. ${STATELESS}`);
      }
    }
    broke = false;
    if (inert >= 0) { i = last = inert; ended = true; continue; }
    if (IDENT_CHAR.test(c)) {
      const word = /^[\w$]+/.exec(s.slice(i))?.[0] ?? c;
      i = last = i + word.length - 1;
      ended = !UNFINISHED_AT_EOL.has(word);
      continue;
    }
    last = i;
    if (c === '=' && s[i + 1] === '>') { if (depth === 0 && angle === 0) arrow = true; i = last = i + 1; ended = false; continue; }
    if (depth === 0 && angle === 0 && !isType && !assigned) {
      if (c === ':') typed = true;
      else if (c === '=') { assigned = true; typed = false; }
    }
    if (c === '{' || c === '(' || c === '[') { depth++; ended = false; continue; }
    if (c === '}' || c === ')' || c === ']') { if (depth > 0) depth--; ended = true; continue; }
    if (typed && depth === 0 && c === '<') { angle++; ended = false; continue; }
    if (typed && depth === 0 && c === '>' && angle > 0) { angle--; ended = true; continue; }
    // Postfix `++`/`--` and a non-null `!` leave an expression complete; every other punctuator does not.
    ended = ((c === '+' || c === '-') && s[i - 1] === c) || (c === '!' && ended);
  }
  return last;
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function assertPackageName(name: string): void {
  // No `__` inside and no trailing `_`, so `<package>__<export>` splits back one way only.
  if (!/^[A-Za-z_]\w*$/.test(name) || name.includes(PACKAGE_SEPARATOR) || name.endsWith('_')) {
    throw new Error(`package name "${name}" must be an identifier of letters, digits and single underscores, not ending in "_" (it prefixes each tool name as "${name}${PACKAGE_SEPARATOR}<function>").`);
  }
}

function nextSignificant(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (/\s/.test(s[i] as string)) continue;
    if (s[i] === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) { i = inertEnd(s, i); continue; }
    return i;
  }
  return -1;
}

/** The index of the `}` closing a function whose parameter list opens at `open`. A brace-bearing return
 *  type (`: { a: number }`) is recognised by what follows its `}` — the body's `{`, or more type. With
 *  `overload`, a top-level `;` before any body ends a bodiless overload signature there. */
function functionEnd(s: string, open: number, overload = false): number {
  const close = matchParen(s, open);
  if (close === -1) return -1;
  let depth = 0;
  for (let i = close + 1; i < s.length; i++) {
    const inert = inertEnd(s, i);
    if (inert >= 0) { i = inert; continue; }
    const c = s[i];
    if (c === '=' && s[i + 1] === '>') { i++; continue; }
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '>') { if (depth > 0) depth--; }
    else if (c === ';' && depth === 0 && overload) return i;
    else if (c === '{' && depth === 0) {
      const end = matchBrace(s, i);
      if (end === -1) return -1;
      const next = s[nextSignificant(s, end + 1)];
      if (next === '{' || next === '|' || next === '&' || next === '[') { i = end; continue; }
      return end;
    }
  }
  return -1;
}

/** The comment directly above `at` (a block comment, or a run of line comments), as prose. */
function leadingComment(s: string, at: number): string | undefined {
  let k = at;
  while (k > 0 && /[ \t]/.test(s[k - 1] as string)) k--;
  if (k > 0 && s[k - 1] !== '\n') return undefined;
  const before = s.slice(0, k).replace(/\s+$/, '');
  if (before.endsWith('*/')) {
    const start = before.lastIndexOf('/*');
    if (start === -1) return undefined;
    const text = before.slice(start + 2, -2).replace(/^\*/, '')
      .split('\n').map(l => l.replace(/^\s*\*?\s?/, '')).join('\n').trim();
    return text === '' ? undefined : text;
  }
  const lines = before.split('\n');
  const taken: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = (lines[i] as string).match(/^\s*\/\/\s?(.*)$/);
    if (m === null) break;
    taken.unshift(m[1] as string);
  }
  const text = taken.join('\n').trim();
  return text === '' ? undefined : text;
}

const unwrapPromise = (t: string): string => t.match(/^Promise\s*<([\s\S]*)>$/)?.[1]?.trim() ?? t;

/**
 * Find a package module's top-level `export`ed functions and derive each one's tool: its name, schema and
 * contract. Everything not exported — helper functions, types, constants — is left to the module, which
 * is what makes it private: it is never registered, so there is nothing to hide from anyone.
 */
export function parsePackage(packageName: string, source: string): ParsedPackage {
  assertPackageName(packageName);
  assertStatelessTopLevel(source);
  const exports: PackageExport[] = [];
  const exportAt: number[] = [];
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const inert = inertEnd(source, i);
    if (inert >= 0) { i = inert; continue; }
    const c = source[i];
    if (c === '{' || c === '(' || c === '[') { depth++; continue; }
    if (c === '}' || c === ')' || c === ']') { if (depth > 0) depth--; continue; }
    if (depth !== 0 || !source.startsWith('export', i)) continue;
    if (i > 0 && IDENT_CHAR.test(source[i - 1] as string)) continue;
    if (IDENT_CHAR.test(source[i + 6] ?? '')) continue;

    const head = source.slice(i + 6).match(/^\s+((?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*)([(<])/);
    if (head === null) {
      const what = source.slice(i, i + 40).split('\n')[0];
      throw new Error(`only functions can be exported from a package — found \`${what}\`. Types, constants and helpers are private to the package; drop their \`export\`.`);
    }
    if (/\*/.test(head[1] as string)) throw new Error(`exported function "${head[2]}" is a generator — a tool returns one result.`);
    if (head[3] === '<') {
      throw new Error(`exported function "${head[2]}" is generic — a tool's input and result contracts must be concrete types. Keep the generic function private (drop its \`export\`) and export a non-generic wrapper that calls it.`);
    }
    const fnStart = i + 6 + (head[0].length - head[1]!.length - 1);
    const open    = i + 6 + head[0].length - 1;
    const end     = functionEnd(source, open);
    if (end === -1) throw new Error(`could not find the body of exported function "${head[2]}" — check that its braces balance.`);
    const fnSource = source.slice(fnStart, end + 1);
    exports.push(deriveExport(packageName, head[2] as string, fnSource, leadingComment(source, i)));
    exportAt.push(i);
    i = end;
  }

  if (exports.length === 0) throw new Error('a package must export at least one function — each exported function becomes a tool.');
  const names = new Set<string>();
  for (const e of exports) {
    if (names.has(e.name)) throw new Error(`function "${e.name}" is exported twice.`);
    names.add(e.name);
  }
  return { exports, exportAt };
}

function deriveExport(packageName: string, name: string, fnSource: string, description: string | undefined): PackageExport {
  if (!/^[A-Za-z]\w*$/.test(name) || name.includes(PACKAGE_SEPARATOR)) {
    throw new Error(`exported function "${name}" must start with a letter and contain no "${PACKAGE_SEPARATOR}" — its tool name is "${packageName}${PACKAGE_SEPARATOR}${name}", which must read back one way.`);
  }
  const toolName = `${packageName}${PACKAGE_SEPARATOR}${name}`;
  if (toolName.length > MAX_TOOL_NAME) throw new Error(`tool name "${toolName}" is longer than ${MAX_TOOL_NAME} characters, which providers reject — shorten the package or function name.`);

  const sig = parseSignature(fnSource);
  // One object parameter (or none) — the lambda convention, so a call to it from inside the package and
  // `tool.<package>__<name>(…)` from outside take the same argument.
  if (sig.params.length > 1) throw new Error(`exported function "${name}" takes ${sig.params.length} parameters — a tool takes ONE object parameter, e.g. \`${name}(args: { a: string; b: number })\`.`);
  const param = sig.params[0];
  if (param !== undefined && param.type === undefined) throw new Error(`exported function "${name}" must declare its parameter's type — it becomes the tool's input contract.`);
  if (sig.returnType === undefined) throw new Error(`exported function "${name}" must declare a return type — it becomes the tool's result contract (\`Promise<void>\` for a side effect).`);

  const schema = param === undefined ? { properties: {} } : tsTypeToSchema(param.type);
  if (schema.type !== undefined && schema.type !== 'object') {
    throw new Error(`exported function "${name}" takes a ${String(schema.type)} — a tool's parameter must be an object, e.g. \`${name}(args: { value: ${param?.type ?? 'string'} })\`.`);
  }
  const resultType = unwrapPromise(sig.returnType);
  return {
    name, toolName,
    ...(description !== undefined ? { description } : {}),
    source: fnSource,
    ...(param !== undefined ? { param } : {}),
    resultType,
    inputSchema: { ...schema, type: 'object' },
    toolContract: `ToolContract<${resultType}, ${param?.type ?? '{}'}>`,
  };
}

// Which export to call, and its argument: reserved parameter names, chosen not to collide with an author's.
const EXPORT_NAME = '__matbotExport';
const EXPORT_ARG  = '__matbotExportArg';

/**
 * Compile a package module into a function that evaluates it and calls one of its exports. The module is
 * evaluated afresh on every call, closing over that call's `tool`/`toolInContext`/`context`: a package is
 * a namespace, never an object with a lifetime, so interleaved calls, reload, swap and principal scoping
 * ask nothing new of it. {@link parsePackage} refuses the top-level forms that would make that observable.
 *
 * The export is called inside the module body, in the same synchronous run as its evaluation, rather than
 * after awaiting the module: that await would start the export's own work outside any stretch a
 * {@link FunctionRunner} bounds.
 */
export async function buildPackageFn(stripper: TypeScriptStripper, source: string, parsed: ParsedPackage, runner?: FunctionRunner): Promise<PackageFn> {
  let blanked = source;
  for (const at of parsed.exportAt) blanked = `${blanked.slice(0, at)}      ${blanked.slice(at + 6)}`;
  let stripped: string;
  try { stripped = await stripper.strip(blanked); }
  catch (e) { throw new Error(`not valid TypeScript (${msg(e)})`); }
  const body = `${stripped}\n;return ({ ${parsed.exports.map(e => e.name).join(', ')} })[${EXPORT_NAME}](${EXPORT_ARG});`;
  const params = [...INJECTED, EXPORT_NAME, EXPORT_ARG];
  try { return runner !== undefined ? runner.compile(params, body) as PackageFn : new AsyncFunction(...params, body); }
  catch (e) { throw new Error(`could not compile (${msg(e)})`); }
}

/** One export of a compiled package, in the calling convention `runFunction` drives. */
export function exportFn(pkg: PackageFn, name: string): CompiledFn {
  return (tool, toolInContext, context, arg) => pkg(tool, toolInContext, context, name, arg);
}
