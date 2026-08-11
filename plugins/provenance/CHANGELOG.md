# @matatbread/matbot-provenance

## 0.4.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.4.2

## 0.3.10

### Patch Changes

- Tool media, per-provider round ceiling, and recovery from a truncated tool call.

  - `model-content` ToolEvent: a tool can hand the model an image, PDF or audio clip to look at. Pinned
    after the tool message it answers, carried for the rest of the turn, never persisted.
  - `document` converts natively for Anthropic (base64 PDF, decoded `text/*`) and Gemini (`inlineData`,
    which also covers audio) instead of degrading to a text placeholder in every adapter.
  - `ProviderConfig.maxRounds`: a per-profile ceiling on tool rounds per turn. Replaces the removed
    `ProviderConfig.fallback`, which was declared, parsed, and read by nothing.
  - A tool call cut off mid-arguments is answered with an error result instead of throwing, so the model
    self-corrects; a response cut short is recorded as an LLM-invisible `matbot-truncation` marker.
  - Fixes: `complete()` folds usage events instead of last-event-wins; `followup` no longer runs after an
    aborted or errored turn; a `toolcall` abort commits the turn; `FilesystemStore` escapes store ids
    that are not filename-safe rather than rejecting them; the anthropic adapter no longer emits adjacent
    same-role messages; openai-compat terminates a stream with exactly one `done`.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10

## 0.3.9

### Patch Changes

- **Optional (provenance).** A tool can be excluded from the search pool, and `determine_provenance`
  excludes itself by default. Its own results are verdicts _about_ claims rather than observation of the
  world, so a second pass over a session it had already judged found its own prior output and cited it as
  evidence for the very claim that output was a verdict on — circular, and confidently so, since the
  extract genuinely does contain the claim's every key. The exclusion list resolves at three levels: the
  `ignoreTools` call parameter, then a pin held by `provenance_config`, then the coded default
  (`["determine_provenance"]`). An explicit empty array at either settable level means "include
  everything" and is distinct from omission, which falls through to the next level; the same three-level
  shape also serves suppressing a verbose tool whose output is noise rather than record. Only tool output
  is filtered — `USER` messages never are, because a user quoting a tool result is still the user
  speaking, and the quotation is legitimate provenance for what they were told. `provenance_config` now
  carries both settings: `set` takes `provider` and/or `ignoreTools` (at least one, each validated
  independently), `get` reports the current values _and_ the coded default so a caller can see what it is
  overriding, and `clear` resets both.
- **Optional (provenance).** A strict-key veto is its own verdict, and every result says which keys were
  found. A caller-supplied key appearing nowhere zeroes the search (it always did — material found on the
  _other_ keys would read as corroboration for a term the session does not mention), but the empty result
  was then indistinguishable from finding nothing at all, and the two mean opposite things: "this specific
  term isn't here" is a located absence, "nothing bearing on this is here" is a diffuse one. The first is
  now reported as `vetoed`, skipping both the reader and the cold probe — the veto is about session
  content, not about the model's prior, so re-asking the model would answer a different question.
  Alongside it, every verdict carries `keyHits`: per key, whether any spelling of it was seen and which
  sources it was seen in (`USER`, `TOOL:<name>`). On a composed claim that is the part a verdict alone
  cannot express — which terms are retrieved and which are fabricated — and a `vetoed` verdict names its
  offender as the entry with `found: false`. The tool description now asks callers to split composite
  terms into their discriminating parts, so the veto can pinpoint rather than merely fire.
  - @matatbread/matbot-plugin-api@0.3.9
