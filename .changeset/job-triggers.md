---
"@matatbread/matbot-background-jobs": patch
"@matatbread/matbot-background-jobs-node": patch
---

A background job takes `triggers: 'all' | 'reply' | 'none'`: which parts of its own turn the triggers judge. `background_job_action update` changes it on a stored job. Applied through `TriggerFilter`; absent is `all`, as before.
