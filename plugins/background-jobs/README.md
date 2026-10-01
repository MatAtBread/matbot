# @matatbread/matbot-background-jobs

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

Run prompts as background jobs — now, at a time (`at`), or on an interval — with the `background_job` and
`background_job_action` tools. It supersedes `@matatbread/matbot-tool-background`, with one change of meaning:

**A job's reply is not its output.** Nothing a job prints reaches anyone. A job tells the user something by
appending a message to a conversation (`session_action` `append`) — by default the one the job was created
from — where the user sees it and can follow up with its context. It can also write files or send a bare
Telegram notification if its prompt asks for that, and a job with nothing worth saying ends silently. So a
job's prompt says what to tell the user and when: *"Check the balance; if it is over 50M, tell the user."*

A job runs in its own process and shares this one's storage, but none of its turns, so it never writes a
session itself: its appends go back over an IPC channel to the process that started it, which applies them
when no turn is running. What else the job changes (a file it writes) is announced there too, so the web UI
shows it.

## Moving from `matbot-tool-background`

Load this plugin **instead of** the old one. Its tools have their own names, because their meaning differs,
and it keeps its own store, so the old plugin's schedules are not run. `background_job_action list` shows them
marked `"legacy": true`: create each again with `background_job` (rewording the prompt to say what to tell
the user), then `cancel` the legacy row. A warning at startup counts any that are left.
