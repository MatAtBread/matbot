import { PLUGIN_API_VERSION, ItemChangeKind, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import type { ToolInputValidator } from '@matatbread/matbot-core';
// A HARD dependency, and a direct one — a `dependencies` entry, the same relationship `mcp` has to
// `mcp-http`. tool-types SUPPLIES validation (it does the type formation and analysis — the dts, the
// wire contracts, the JSON Schemas, and a validator emitted from each tool's resolved params type);
// this package consumes that and provides the service core consults. There is nothing to validate
// against without it, so this is not a capability to negotiate for: it is imported and, if it is not
// already loaded, INSTALLED here.
//
// Which is what removes the load-order requirement rather than working around it. Requiring tool-types
// to be listed first made the ordering a silent config trap; latching on the mount table instead would
// let this plugin load and then quietly validate nothing until its peer arrived. Neither is needed for
// a dependency this hard — the module is already in hand, so the service can simply be stood up.
import { asToolValidatorSupplier, createToolTypesPlugin } from '@matatbread/matbot-tool-types';
import type { ToolValidatorSupplier } from '@matatbread/matbot-tool-types';

// The typed twin of `json-validation`. That one checks a tool's `inputSchema`; this one checks the
// `ToolContract` params TYPE the schema is DERIVED from. The difference is not academic — for a
// multi-action tool a single JSON Schema cannot say "title is required WHEN action is rename", so
// `session_action`'s schema requires only `action` and every per-arm requirement is lost. That is why
// such tools hand-write their own checks today.
//
// It is NOT a hook. A `toolcall` hook is a runner channel, so it guards the model's path and nothing
// else — `POST /tools/:name` and `invokeTool` call `tool.executor.execute` directly and fire no hooks.
// Core consults `ToolCallValidator` at the executor instead, which every door already passes through:
// one check rather than one per door, and nothing to drift.

const PLUGIN_NAME = '@matatbread/matbot-tool-ts-validation';

/** `reject` refuses the call; `warn` logs and allows it; `off` disables validation from this plugin. */
type Enforcement = 'off' | 'warn' | 'reject';

const ENFORCE_KEY = 'enforce';
// Loading this plugin IS the opt-in, so the default enforces. `warn` exists for a rollout — one release
// of "would reject" in the log makes visible any caller that has been getting away with a loose payload
// (the web UI drives several panels through tool routes) before it becomes a failure — but it is a
// deliberate choice, not the resting state. Set it with `default_settings` in matbot.yaml.
const DEFAULT_ENFORCEMENT: Enforcement = 'reject';

function isEnforcement(v: unknown): v is Enforcement {
  return v === 'off' || v === 'warn' || v === 'reject';
}

// The routing namespace core announces settings writes under. A literal rather than a core import:
// only core's TYPES are a dependency here (and those are erased), and the announcement is now
// self-describing enough that nothing else about the medium needs importing — see the filter below.
const SETTINGS_NAMESPACE = 'settings';

/**
 * The `ToolTypeIndex` this plugin installed itself, if it had to. Held so `teardown` can close it —
 * the index owns a worker thread — and so a live `unregister` of the service does not strand this
 * plugin without a supply.
 *
 * Presence is DUCK-TYPED (`asToolValidatorSupplier`), never `instanceof ToolTypeIndexImpl`. A reload
 * of tool-types leaves two module copies in the registry, so `instanceof` would report "not mine" for
 * a perfectly good index and install a second one — the same reason `asProfileDirectory` tests for a
 * method rather than a class.
 */
let installed: { spec: MatbotPluginSpec; index: ToolValidatorSupplier } | undefined;
let installing: Promise<ToolValidatorSupplier> | undefined;

/**
 * The registered service if there is one, else the one this plugin stands up. Resolved per call rather
 * than captured, so a properly-loaded tool-types is preferred the moment it appears, and an unload of
 * it underneath us is survived rather than fatal.
 *
 * This used to FAIL CLOSED — every tool call rejected with "the validator supply is gone" — on the
 * argument that a call which cannot be verified must not proceed. In practice that bricked the machine:
 * every tool failed, including the `plugin` tool needed to put tool-types back and the calls the web UI
 * makes to draw itself, so the only way out was a restart. A dependency this plugin can simply
 * re-create is not a failure at all.
 */
async function supplyFor(services: MatbotMachine): Promise<ToolValidatorSupplier> {
  const registered = asToolValidatorSupplier(services.ToolTypeIndex);
  if (registered) return registered;
  if (installed) return installed.index;
  // Latched: concurrent tool calls must not each stand up an index (and its worker).
  installing ??= (async () => {
    const spec = createToolTypesPlugin();
    await spec.setup?.(services);
    const index = asToolValidatorSupplier(services.ToolTypeIndex);
    if (!index) throw new Error(`${PLUGIN_NAME}: @matatbread/matbot-tool-types did not register a ToolTypeIndex`);
    installed = { spec, index };
    return index;
  })();
  try { return await installing; } finally { installing = undefined; }
}

function makeValidator(services: MatbotMachine, signal: AbortSignal): ToolInputValidator {
  // Reported once per tool, not per call: a refusal or caveat is a property of the CONTRACT, so
  // repeating it on every invocation would bury the turn's real output.
  const noted = new Set<string>();
  // Whatever held the key before us — typically `json-validation`. Delegated to whenever this plugin
  // has no opinion, so the two compose along the line the type system already draws: typed contracts
  // here, loose `inputSchema` there. Without this the later-loading plugin would simply shadow the
  // earlier one.
  const previous = services.ToolCallValidator;

  // `enforce` is read on every tool call through every door, and `PluginSettings.get` is a store read —
  // on the filesystem backend, a disk read — to re-learn a value that changes approximately never. So it
  // is cached, which is only correct because a settings write now publishes an `ItemChange` (#58):
  // invalidation is an event rather than a TTL, which is either too short to help or long enough that an
  // operator's change appears not to work.
  //
  // Keyed by principal, because a settings override is per-principal — one user's `warn` must not become
  // everyone's.
  //
  // Matched on `key`, the settings namespace the write was addressed by, against this plugin's own name.
  // NOT on `id`, which is that name slugged to a legal document id by whatever the medium requires: a
  // copy of that rule here would keep compiling after core's changed and silently never match again,
  // leaving a cache that never invalidates — worse than the store read it replaced. An announcement with
  // no `key` (a producer older than the field) invalidates everything, since failing loose costs one
  // extra read and failing tight costs a setting that appears not to work.
  const self   = services.self?.name;
  const cached = new Map<string, Enforcement>();
  services.Notifier.consume(n => {
    if (n.kind !== ItemChangeKind || n.namespace !== SETTINGS_NAMESPACE) return;
    if (n.key !== undefined && self !== undefined && n.key !== self) return;
    const owner = n.principal?.id;
    if (owner === undefined) cached.clear();
    else cached.delete(owner);
  }, signal, n => n.kind === ItemChangeKind);

  const enforcement = async (): Promise<Enforcement> => {
    const key = tryCurrentPrincipal()?.id ?? '';
    const hit = cached.get(key);
    if (hit !== undefined) return hit;
    const raw      = await services.settings().get<string>(ENFORCE_KEY);
    const resolved = isEnforcement(raw) ? raw : DEFAULT_ENFORCEMENT;
    cached.set(key, resolved);
    return resolved;
  };

  return {
    async validateToolCall(name, parameters) {
      const enforce = await enforcement();
      if (enforce === 'off') return previous?.validateToolCall(name, parameters);

      // Resolved per call rather than captured, so an unload/reload of tool-types is followed rather
      // than pinned — and re-created if it went away entirely, which is why nothing here can be
      // "unverifiable".
      const supplier: ToolValidatorSupplier = await supplyFor(services);
      const entry = (await supplier.toolValidators())[name];

      // No contract for this tool, or one that could not be honestly validated as JSON. Either way this
      // plugin has NO OPINION — never "valid" — so hand over to whoever came before (json-validation
      // checks its `inputSchema`) and say once that the typed path did not cover it.
      if (entry === undefined || 'refused' in entry) {
        if (!noted.has(name)) {
          noted.add(name);
          console.warn(entry === undefined
            ? `[ts-validation] Tool "${name}" has no typed contract; not validated here${previous ? ' (deferring to the validator this displaced)' : ''}.`
            : `[ts-validation] Tool "${name}" has a contract that cannot be validated as JSON: ${entry.refused}. Not validated here.`);
        }
        return previous?.validateToolCall(name, parameters);
      }

      // A validator that WAS generated may still accept more than it appears to — an `any` member, a
      // bare `object`, a `Map` that reaches the wire as `{}`. Surfaced once per tool for the same
      // reason: "validated" should not be read as "fully constrained".
      if (!noted.has(name)) {
        noted.add(name);
        if (entry.warnings.length) {
          console.warn(`[ts-validation] Tool "${name}" is validated, with unconstrained field(s): ${[...new Set(entry.warnings)].join('; ')}`);
        }
      }

      const errs = entry.validate(parameters);
      if (errs.length === 0) return [];
      if (enforce === 'warn') {
        console.warn(`[ts-validation] Would reject "${name}": ${errs.map(e => `${e.path}: ${e.message}`).join('; ')} (enforce: 'warn' — the call proceeded)`);
        return [];
      }
      // Returned verbatim: core turns these into the error the model reads and self-corrects against,
      // and a transport can answer 422, so the JSON Pointer paths must survive intact.
      return errs;
    },
  };
}

/** Ends the validator's settings-invalidation subscription at teardown. */
let invalidation: AbortController | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: { description: 'Enforces each tool\'s ToolContract params type at the executor, via core\'s ToolCallValidator seam — so the model\'s path, HTTP tool routes and invokeTool are all checked by one validator.' },

  async setup(services) {
    // Stand the supply up now if nothing else has, so a first tool call does not pay for it and a
    // misordered `plugins:` is not a config trap. Listing tool-types too is still the better setup —
    // then it owns the service, other consumers (function-tools, skills_compiler) get it, and this
    // resolves to theirs — but it is no longer a requirement.
    await supplyFor(services);
    invalidation = new AbortController();
    await services.register('ToolCallValidator', makeValidator(services, invalidation.signal));
  },

  // Only ever closes an index this plugin installed itself. One that tool-types registered is
  // tool-types' to close, and the loader already unregisters the key before calling its teardown.
  async teardown() {
    // The cache-invalidation subscription is this plugin's own, not a host-scoped interest, so it ends
    // here — otherwise an unload leaves a handler writing into a torn-down closure once per reload.
    invalidation?.abort();
    invalidation = undefined;
    const own = installed;
    installed = undefined;
    await own?.spec.teardown?.();
  },
};
