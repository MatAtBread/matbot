---
"@matatbread/matbot-core": patch
"@matatbread/matbot-tool-types": patch
"@matatbread/matbot-tool-ts-validation": patch
"@matatbread/matbot-tool-json-validation": patch
"@matatbread/matbot-triggers": patch
"@matatbread/matbot-frontend-web": patch
"@matatbread/matbot-tool-whoami": patch
"@matatbread/matbot-cognition": patch
"@matatbread/matbot-frontend-telegram": patch
---

Generalize tool-call validation from `LLM -> tool` to `* -> tool`.

Validation was a `toolcall` hook, and that channel is the RUNNER's: it guarded the model's path while
`POST /tools/:name` and `invokeTool` called `tool.executor.execute` directly and fired no hooks at all.
Core now consults an optional `ToolCallValidator` service **at the executor**, wrapped once per tool at
registration — the one place every door already passes through. With no validator registered nothing
changes, so core still mandates no validation; it only honours one that is registered. A rejected call
yields an `error` event carrying the offending field paths and a 4xx code (`TOOL_INPUT_INVALID`), which
the web tool route now answers with rather than 500.

**ToolContract type validation.** `tool-types` emits a pure-JS validator per tool from the checker's
resolved type, inside the pass that already builds the dts — so conditionals, generics, `Omit`/`Pick`/
`Record` and indexed access arrive already evaluated, and the workspace is not scanned twice. It targets the
JSON *projection* of the type (a `toJSON` return wins, a class instance is its own data properties,
methods and function-valued fields cannot appear on the wire), so only `bigint` is refused — the one
thing `JSON.stringify` itself throws on. A contract that cannot be honestly validated yields a stated
refusal rather than a permissive validator.

**The error names the field as a caller would write it, and shows what was sent:**

```
Invalid input for tool "about_matbot": .x: never (no value is valid), actual value `{"x":8}`
```

Paths are dotted (`.items[0].name`) rather than JSON Pointer (`/items/0/name`), because the reader is
either a model repairing its own call or a developer looking at a 422, and both write dots. The value is
rendered wrapped in its own field name, so it is a fragment the caller can compare against what it sent;
an array element or the root has no name to wrap it in and renders alone. A missing property shows no
value — JSON carries no `undefined`, so there is nothing to show beyond saying it is absent. The
rendering is capped, so a rejected attachment cannot turn one bad field into the bulk of a turn's
context, and it cannot throw: with validation now covering internal calls, a caller can arrive with a
bigint or a cycle, and a throw while reporting an error would replace the diagnosis with a stack trace.
Both validators report this way, so which one rejected a call is invisible to the caller.

**An unknown property is rejected**, as TypeScript rejects one on a fresh object literal — which is
exactly what a model-authored params object is. An invented or misspelled key otherwise fails silently:
it is dropped, and the tool runs believing it was never passed (`sessionId` mis-sent as `session_id`
reads as "no session given" rather than as a typo), which is the commonest tool-call hallucination there
is. On a multi-action tool the error is reported against the arm the discriminant selected, so it names
the right field set. `enforce: 'warn'` is the way to find existing loose callers before this bites.

**Tools built at runtime are validated too.** A tool with no scannable source declares its contract as
a `toolContract` STRING (`function-tools`' generated functions, `tool-store`'s per-namespace tools), and
a string is not a `ts.Type`. Those strings are now rendered into a virtual augmentation file and typed,
so the same emitter runs over them and a runtime-built tool is enforced exactly like a compiled one —
per arm, nested fields included. This matters more than it sounds: those are the tools whose parameters
an LLM authored, so they were the ones described in full and enforced least.

Each string is screened alone before the batch is rendered, since they become properties of one
interface where a stray brace would swallow every arm after it, and the file must then typecheck
CLEANLY — an unresolved type reference is `any`, which validates everything, so a fault becomes a stated
refusal (and `ts-validation` defers to the `inputSchema`) rather than a validator that reports success
and checks nothing. The wire text and the dts arm are still spliced verbatim from the string, because
that is what the model already reads and re-deriving it would expand aliases the author chose.

tool-types **supplies** validation and registers no validator service: `toolValidators()` on its
`ToolTypeIndex` hands out the generated validators, and that is all. A code generator loading it for
`dts()` alone must never silently start having its tool calls rejected.

**Enforced by `ts-validation`** (new), which consumes that supply directly, applies a policy, and
registers the `ToolCallValidator` core consults — `enforce: off | warn | reject`, defaulting to
`reject`, since loading it is the opt-in.

Its dependency on tool-types is hard and direct — a `dependencies` entry and a plain import, the same
relationship `mcp` has to `mcp-http` — so it **installs the service itself** when nothing else has.
There is therefore no load-order requirement and no mount-table latch: listing tool-types as well is
still the better setup (it then owns the service, and other consumers such as `function-tools` and
`skills_compiler` get one too), but omitting it costs nothing. Presence is duck-typed rather than
`instanceof`-tested, so a reloaded tool-types is recognised instead of being duplicated.

That also removes a way to brick a running machine. This plugin previously failed CLOSED if the index
went missing after setup — an error on every call whose contract it could not verify — which sounds
right until tool-types is unloaded: *every* tool then fails, including the `plugin` tool needed to put
it back and the calls the web UI makes to draw itself, leaving a restart as the only way out. A
dependency the plugin can simply re-create was never an unverifiable call.

**`json-validation` moves to the same seam** and is no longer a hook, so its schema checking now covers
every door too (and works in the browser, where tool-types cannot run). A validator that displaces
another captures and defers to it when it has no opinion, so typed and schema validation compose along
the line the type system already draws — typed contracts first, loose `inputSchema` behind.

**`trigger_action` fix, found by enforcing the above.** The `update` arm accepts `cooldown: null` to
clear the stored limits — the executor has always honoured it, its own error message documents it, and
the web UI has always sent it — but the contract declared `cooldown?: TriggerCooldown`, making a
documented call untypeable. Now `TriggerCooldown | null`, and the tool description says so rather than
only the error path. `add` deliberately still refuses `null`: there is no prior limit to clear.

