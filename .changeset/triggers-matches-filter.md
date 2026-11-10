---
"@matatbread/matbot-triggers": patch
---

The classifier lists only the conditions that match, each with its evidence (`{ "matched": [{ "id", "why" }] }`), and its conditions are in the system prompt rather than after the exchange, so they are a stable prefix any provider's prompt cache can reuse. A reply in the old per-condition shape counts only an explicit `{ "match": true }` or `true`. `TriggerManager.evaluate` takes the session first. With `classifierGraceMs` set, the hold's timer is cleared when the verdict wins.

A `TriggerFilter` service, registered by the plugin that holds the policy, withholds triggers from one conversation: `admit(triggers, { session, surface })` answers with those that may be judged, and a withheld trigger is never shown to the classifier. The answer is read as a subset of the offer in stored order; a filter that throws is skipped, with every trigger judged.
