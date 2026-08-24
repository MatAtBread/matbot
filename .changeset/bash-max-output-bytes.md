---
'@matatbread/matbot-tool-bash': patch
'@matatbread/matbot-tool-docker-bash': patch
---

`bash` output is bounded by a **default**, not a hard limit: `maxOutputBytes` overrides it per call.

0.4.9 gave the local `bash` an output cap with no way past it, justified by parity with `docker-bash` —
while omitting the half of `docker-bash` that makes a cap survivable. A bound the caller cannot lift is not
a safety net, it is a ceiling on what the tool can be used for: the only party who knows whether 400KB of
output is a verbose build or a `yes` loop is the one that wrote the command.

So `maxOutputBytes?: number` joins the `bash` params — declared identically in both plugins, since they
share one tool name and therefore one merged contract — and both honour it. In `docker-bash` it overrides
the `bash_config` setting for that one command, leaving the persisted setting as the default for the rest;
that setting was also the only route before, and changing a global to get one verbose build through is the
wrong shape of answer.

**The default rises from 100000 to 1000000 bytes in both.** The two failure directions are not symmetric:
output that overflows is output whose process was *killed*, so too low a default kills legitimate work —
while runaway protection barely notices, because anything genuinely runaway emits megabytes a second and
trips either number in well under a second. Overflow now also names the remedy, which it could not before.

A nonsensical value (zero, negative, non-finite) is refused before the script runs rather than silently
falling back to the default.
