/**
 * matbot's typed errors are **duck-typed, not class-based**: each is a plain `Error` carrying a
 * `matbot` brand string (the discriminant) plus its data fields. Callers test the brand through the
 * exported `isX` guards — never `instanceof`.
 *
 * Why not classes: plugin-api can be physically duplicated in a skewed install (two copies at
 * different versions). A class is a per-copy object, so `instanceof MissingSecretError` returns
 * `false` when the host throws from one copy and a plugin tests with another — silently breaking
 * error handling across the boundary. A brand string is identity-independent, so the guard holds no
 * matter how many copies are loaded. See docs/duplicate-singletons.md.
 *
 * The interfaces are kept named `XError` so existing `import type { XError }` annotations and field
 * access (`e.missingKeys`) survive; only construction (`new XError()` → `xError()`) and detection
 * (`instanceof XError` → `isXError()`) change.
 */

const BRAND = 'matbot';

export type MatbotErrorKind = 'MissingSecret' | 'IncompatibleRuntime' | 'NotAPlugin' | 'PromptCancelled' | 'ReadOnly' | 'MediaRejected';

function isKind(e: unknown, kind: MatbotErrorKind): boolean {
  return typeof e === 'object' && e !== null && (e as Record<string, unknown>)[BRAND] === kind;
}

/**
 * Thrown by Vault.resolve() when one or more ${NAME} placeholders cannot be resolved.
 * `missingKeys` carries the unresolved key names (e.g. `ANTHROPIC_API_KEY`) so callers
 * can prompt for and store them.
 */
export interface MissingSecretError extends Error {
  matbot: 'MissingSecret';
  readonly missingKeys: readonly string[];
}
export function missingSecretError(missingKeys: readonly string[]): MissingSecretError {
  const e = new Error(`Vault: secret(s) not found: ${missingKeys.join(', ')}`);
  e.name = 'MissingSecretError';
  return Object.assign(e, { matbot: 'MissingSecret' as const, missingKeys });
}
export function isMissingSecretError(e: unknown): e is MissingSecretError {
  return isKind(e, 'MissingSecret');
}

/**
 * Thrown by the loader when an explicit, single, user-initiated load (the `plugin`/`provider`
 * tools via `services.loadPlugin`) targets a plugin whose `matbotRuntime` excludes this host.
 * Unlike a setup() failure — which may be transient (a missing secret) and is left in config to
 * fix — this is permanent for the host, so the `add` flow catches it specifically and rolls the
 * specifier back out of matbot.yaml rather than persisting a plugin that can never activate here.
 */
export interface IncompatibleRuntimeError extends Error {
  matbot: 'IncompatibleRuntime';
  readonly specifier:   string;
  readonly declared:    readonly string[];
  readonly hostRuntime: string;
}
export function incompatibleRuntimeError(specifier: string, declared: readonly string[], hostRuntime: string): IncompatibleRuntimeError {
  const e = new Error(`Cannot load plugin "${specifier}": declares matbotRuntime [${declared.join(', ')}], host runtime is "${hostRuntime}".`);
  e.name = 'IncompatibleRuntimeError';
  return Object.assign(e, { matbot: 'IncompatibleRuntime' as const, specifier, declared, hostRuntime });
}
export function isIncompatibleRuntimeError(e: unknown): e is IncompatibleRuntimeError {
  return isKind(e, 'IncompatibleRuntime');
}

/**
 * Thrown by the loader when an explicit, single, user-initiated load targets a module that imports
 * cleanly but is not plugin-shaped — no `plugin` export, a `plugin` without `apiVersion`, or a
 * non-function lifecycle member. Like {@link IncompatibleRuntimeError} this is *permanent* for the
 * specifier (the code is a library, not a plugin), so the `add` flow catches it specifically and
 * rolls the specifier back out of matbot.yaml — distinct from a transient setup() failure (a missing
 * secret), which is left in config to fix. `reason` is the precise shape defect for logs; callers
 * surfacing this to an LLM should prefer a terminal "not a plugin" message over echoing `reason`,
 * which is phrased as a code-fix instruction the model may try to act on.
 */
export interface NotAPluginError extends Error {
  matbot: 'NotAPlugin';
  readonly specifier: string;
  readonly reason:    string;
}
export function notAPluginError(specifier: string, reason: string): NotAPluginError {
  const e = new Error(reason);
  e.name = 'NotAPluginError';
  return Object.assign(e, { matbot: 'NotAPlugin' as const, specifier, reason });
}
export function isNotAPluginError(e: unknown): e is NotAPluginError {
  return isKind(e, 'NotAPlugin');
}

/**
 * Thrown by a `PromptFn` implementation when the user cancels — the "give up" path, not a graceful
 * decline. Callers awaiting `ctx.prompt()` need not branch on it: the surrounding try/catch turns
 * it into a tool error that closes the tool call, while the host separately abandons the turn.
 */
export interface PromptCancelledError extends Error {
  matbot: 'PromptCancelled';
}
export function promptCancelledError(message = 'User cancelled — cannot proceed.'): PromptCancelledError {
  const e = new Error(message);
  e.name = 'PromptCancelledError';
  return Object.assign(e, { matbot: 'PromptCancelled' as const });
}
export function isPromptCancelledError(e: unknown): e is PromptCancelledError {
  return isKind(e, 'PromptCancelled');
}

/**
 * Thrown by a `Store` write when the target item is not owned by the current principal — e.g. a session
 * shared read-only into another profile's partition (see `@matatbread/matbot-storage-profiles`). This is
 * a per-operation condition, **not** a process fault: the turn pump catches it (via {@link isReadOnlyError},
 * never `instanceof`) and surfaces it as a turn error rather than letting it escape the detached pump and
 * crash the host. `namespace`/`id` name the item; `owner` is the owning principal id (`''` for the shared
 * base/global partition).
 */
export interface ReadOnlyError extends Error {
  matbot: 'ReadOnly';
  readonly namespace: string;
  readonly id:        string;
  readonly owner:     string;
}
export function readOnlyError(namespace: string, id: string, owner: string): ReadOnlyError {
  const e = new Error(`${namespace} "${id}" was shared by "${owner || 'global'}" and is read-only.`);
  e.name = 'ReadOnlyError';
  return Object.assign(e, { matbot: 'ReadOnly' as const, namespace, id, owner });
}
export function isReadOnlyError(e: unknown): e is ReadOnlyError {
  return isKind(e, 'ReadOnly');
}

/**
 * Thrown by `SessionRunner.open()` when media attached to a submission cannot be accepted. Refusing at
 * the boundary is the whole point: the alternative is a provider 400 part-way through a turn the user
 * already believes was sent, with no way back. `reason` says which limit bit, and the message NAMES the
 * offending file and its size — a bare "too large" leaves a person guessing which of five attachments
 * to drop.
 *
 * A frontend catches this (via {@link isMediaRejectedError}, never `instanceof`) and tells the user;
 * nothing has been enqueued, so there is no turn to clean up.
 */
export interface MediaRejectedError extends Error {
  matbot: 'MediaRejected';
  /** `no-store` — nothing is registered under `MediaStore`, so there is nowhere to put the bytes.
   *  `too-large` — one file exceeds the per-file cap. `session-quota` — this session's stored media
   *  would exceed its total. `unreadable` — the bytes were malformed: not valid base64, or not the file
   *  type they claim (a renamed, truncated or placeholder file, caught by a magic-byte check).
   *  `unsupported-type` — a type no provider decodes (an iPhone HEIC, an SVG), which would 400 the
   *  request rather than degrade. `unknown-ref` — a submitted `file-ref` does not name media attached
   *  to this session; phrased as unknown rather than forbidden, exactly as `GET /media/:id` reports a
   *  file it will not serve, so a refusal never confirms that an id exists. */
  readonly reason: 'no-store' | 'too-large' | 'session-quota' | 'unreadable' | 'unsupported-type' | 'unknown-ref';
  /** The attachment's display name, when one file is to blame. */
  readonly file?:  string;
}
export function mediaRejectedError(reason: MediaRejectedError['reason'], message: string, file?: string): MediaRejectedError {
  const e = new Error(message);
  e.name = 'MediaRejectedError';
  return Object.assign(e, { matbot: 'MediaRejected' as const, reason, ...(file !== undefined ? { file } : {}) });
}
export function isMediaRejectedError(e: unknown): e is MediaRejectedError {
  return isKind(e, 'MediaRejected');
}
