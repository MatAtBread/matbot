---
"@matatbread/matbot-skills": patch
"@matatbread/matbot-frontend-web": patch
"@matatbread/matbot-cognition": patch
---

Skills can be `candidate`s: analysed but withheld from the model until adopted (`skill_action adopt`); the web skills panel shows them with an Adopt button. Dream-time clusters a grown backlog: groups that belong in an existing skill are merged into it in one call, and new groups become candidate skills. Facts filed in a deleted skill return to the backlog, and a skill added to the roster gives every backlogged fact one more ranking. Dream-time's prompts share a definition of a skill — one specific subject a user's message could name, or a procedure — so the ranker retires facts that are not skill material, the clusterer must say what message would call for each new group, the writer declines a group with nothing a skill would hold, and `remember_fact` stops capturing facts about the assistant's own software, work in progress, readings and dated history, and takes from an assistant message only the facts it commits to. The merger removes a contradiction marker when a new fact settles it.
