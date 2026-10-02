# @matatbread/matbot-background-jobs-node

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

[`@matatbread/matbot-background-jobs`](../background-jobs), with each job run in its own process rather than in
this one. Same tools (`background_job`, `background_job_action`), same store, same meaning — a job reports by
appending to a conversation — so an install switches between the two by changing which one it loads.

A job's process is a full matbot booted from this one's config. It shares this process's storage and none of
its turns, so it never writes a session itself: its appends go back over an IPC channel to the process that
started it, which applies them when no turn is running. What else the job changes (a file it writes) is
announced there too, so the web UI shows it.

Why choose it: a job that hangs, spins or leaks can be killed outright, and nothing it does shares the
server's heap. Why not: every run pays a full boot — every plugin, every index — which an interval job pays on
every tick. Node only.
