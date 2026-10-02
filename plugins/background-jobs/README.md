# @matatbread/matbot-background-jobs

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

Run prompts as background jobs — now, at a time (`at`), or on an interval — with the `background_job` and
`background_job_action` tools. It supersedes `@matatbread/matbot-tool-background`, with one change of meaning:

**A job's reply is not its output.** Nothing a job prints reaches anyone. A job tells the user something by
appending a message to a conversation (`session_action` `append`) — by default the one the job was created
from — where the user sees it and can follow up with its context. It can also write files or send a bare
Telegram notification if its prompt asks for that, and a job with nothing worth saying ends silently. So a
job's prompt says what to tell the user and when: *"Check the balance; if it is over 50M, tell the user."*

## Where a job runs

This package runs each job **in this process**, on an ephemeral run: a private session runner over an
in-memory store, so the job's own transcript is never stored or listed, and it has every tool and provider
the conversations around it have. It reports through its run's appender, which labels each message with the
job. It works in the browser too — but only while a matbot tab is open, since nothing runs a closed one.

## Several matbots, one store

Every open browser tab loads this plugin over the same IndexedDB, so each is a scheduler over one set of
jobs. There is no leader and no lock: **the row is the schedule, and `nextRun` is the claim**. Each scheduler
periodically reads the rows and compare-and-swaps the fire time of every job that is due; the one that wins
the swap runs that job, and the others find a row that is no longer due and leave it alone. So a job fires
once per occurrence however many tabs are open, and a tab can create, suspend, resume or cancel a job another
tab runs, because all four are row writes.

Nothing is held, so a tab closed mid-run owes nothing. For a recurring job that costs one occurrence; a
one-shot's claim moves its fire time out rather than deleting the row, so an unfinished one is claimed again
a few minutes later — at-least-once, which is the better failure for a request that was asked for and never
ran.

Because the claim is a compare-and-swap, this is only as exclusive as the active storage backend's `cas`.
IndexedDB (one readwrite transaction) and SQLite (`BEGIN IMMEDIATE`) are exclusive across realms; the
filesystem store's is in-process only, which is no limitation on the one sanctioned way to run two node
matbots over one `.data` — a job's own child process, which runs no scheduler at all (`isSubAgent()`).

[`@matatbread/matbot-background-jobs-node`](../background-jobs-node) is the same plugin with each job run in
**its own process** instead: a full matbot booted from this one's config. That is a hard boundary — a job that
hangs or leaks can be killed, and shares no heap with the server — at the cost of a whole boot per run. Load
one or the other, not both: they register the same tools and share the same store, so switching keeps your
jobs.

## Moving from `matbot-tool-background`

Load this plugin **instead of** the old one. Its tools have their own names, because their meaning differs,
and it keeps its own store, so the old plugin's schedules are not run. `background_job_action list` shows them
marked `"legacy": true`: create each again with `background_job` (rewording the prompt to say what to tell
the user), then `cancel` the legacy row. A warning at startup counts any that are left.
