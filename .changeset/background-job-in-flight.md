---
"@matatbread/matbot-background-jobs": patch
"@matatbread/matbot-background-jobs-node": patch
---

`background_job_action list` shows what is running in this process: a stored job carries `inFlight`, and a run-now job, which has no row, is listed while it runs, to the principal who started it. `background_job` returns a run-now job's `id`, and `cancel` stops one. `cancel` of an id the caller cannot see now reports "not found" rather than claiming success, stops a run only once the store has accepted deleting its row, and can no longer abort another principal's run. Each run's listener on the plugin's abort signal is released when the run ends.
