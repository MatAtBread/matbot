---
"@matatbread/matbot-background-jobs": patch
"@matatbread/matbot-sessions": patch
---

A job's reporting conversation is stated where the model reads it. `background_job` and `session_action` described the append target as "this conversation" / "a default", which reads as the conversation the model is in when it looks — so a model told the user a job would "report back here" and a job appending with no `sessionId` was assumed to be writing to its own session. The target is fixed when the job is created and stored on the job (unchanged behaviour); the tool descriptions, the `session` parameter and `background_job_action list` now say so, and say that a job's own session is a throwaway nobody reads.
