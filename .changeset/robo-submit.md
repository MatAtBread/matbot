---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-core": patch
"@matatbread/matbot-sessions": patch
"@matatbread/matbot-triggers": patch
"@matatbread/matbot-background-jobs": patch
"@matatbread/matbot-background-jobs-node": patch
"@matatbread/matbot-frontend-web": patch
---

A user message appended to a session is now a robo-submit: it is run as a turn, which meets any running turn as its sender's `mode` says, as the appender's caller and on the session's own model. Before, it was written and left unanswered. The answering model is told who sent it, on the wire only. A run of more than three robo-submits with no message from a person asks whether to continue. Triggers judge a robo-submit like a person's message (`isRequest`). A frontend can register `SessionPrompter` so a robo-submit's questions wait on its session; frontend-web does. `session_action append` takes `submit: 'queue' | 'parallel' | 'interrupt'` (how the request meets a running turn, which only its author can choose), and background jobs and `single_turn` sub-turns may robo-submit. Separately, `session_action list`/`query` report each session's `state` (`prompting`, `running` or `unread`), and `get` takes `markRead`. The runner reports `prompting`, and the web sidebar's dots come from the server, so they survive a reload and light for appended messages.
