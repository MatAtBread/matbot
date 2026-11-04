---
"@matatbread/matbot-triggers": patch
---

Migrating a stored `augment` condition can no longer fail a read. A write-back that throws, such as the `ReadOnlyError` for a trigger shared in read-only, is reported and the trigger still reads as `ephemeral`. It used to reject the whole listing, so none of that principal's triggers fired and `trigger_action list` errored.
