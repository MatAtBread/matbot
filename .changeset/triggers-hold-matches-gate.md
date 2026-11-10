---
"@matatbread/matbot-triggers": patch
---

The answer waits for the user-surface verdict by default: `classifierGraceMs` defaults to 10 s (`DEFAULT_GRACE_MS`) instead of `0`, so a matched `ephemeral`/`contextual` trigger informs the answer instead of retracting it and rerunning the turn. A slower classifier still races; `classifierGraceMs: 0` restores the pure race. This changes every installation that loads `triggers`: a turn with user-surface conditions starts once its classifier settles.

The classifier names only the conditions that match, each with its evidence, and its conditions are in the cached system prompt rather than after the exchange. A reply in the old per-condition shape still counts what it marked matched. `TriggerManager.evaluate` takes the session first.

A `TriggerGate` service, registered by the plugin that holds the policy, withholds triggers from one conversation: `admit(triggers, { session, surface })` answers with those that may be judged, and a withheld trigger is never shown to the classifier. The answer is read as a subset of the offer in stored order; a gate that throws is skipped, with every trigger judged.
