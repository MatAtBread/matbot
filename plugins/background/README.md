# @matatbread/matbot-tool-background

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

> **Deprecated.** Use [`@matatbread/matbot-background-jobs`](../background-jobs) (jobs run in-process,
> cross-runtime) or [`@matatbread/matbot-background-jobs-node`](../background-jobs-node) (each job in its own
> process). A job there reports by appending to a conversation, and either lists this plugin's schedules
> (marked `legacy`) so each can be re-created there and cancelled here.

Run prompts in detached background processes. Schedule recurring prompts with every/every_list/every_cancel/every_suspend/every_resume/everything_suspend/everything_resume.
