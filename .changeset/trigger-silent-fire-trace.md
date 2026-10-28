---
"@matatbread/matbot-triggers": patch
---

A fire whose tool yields no result (`remember_fact`) leaves a `silent-fired` marker (`surface: 'user' | 'agent'`) carrying each trigger's `matched` conditions and the classifier's `why`. Such a fire delivers nothing, so it was the one kind with no fire marker, and which rule fired it — the question a false positive raises — was not recorded. A fire whose tool fails carries `matched` on its error marker instead.

A silent fire now counts towards the trigger's `cooldown`, which is read from fire markers: a silent trigger with a `maxPerTurn` or `quietTurns` was never held back by them, and now is.
