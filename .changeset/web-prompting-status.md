---
"@matatbread/matbot-frontend-web": patch
---

A session waiting on a question for the user shows a red dot in the sidebar instead of the amber busy one, and returns to its ordinary status when the question is answered, cancelled or the turn is aborted. The `session-busy` status event (and `statusEvents()` in both transports) carries `prompting` beside `busy`, replayed to a stream that connects while the question is outstanding — so a conversation nobody is looking at can say it is waiting on you.

Stopping a session in the in-process (browser bundle) transport now cancels a parked prompt, as the server does, instead of answering it with `''` — which the prompt turned into the field's default, an answer nobody gave.
