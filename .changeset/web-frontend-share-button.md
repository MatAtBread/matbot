---
"@matatbread/matbot-frontend-web": patch
---

The chat header gains a share button (shown only when a `profile` tool is registered and a session is
open). Clicking it pops a small menu of target profiles — those that isolate `sessions`, minus the
active one — and each pick POSTs `share` (`{ namespace: 'sessions', id: <session>, target }`) for the
open conversation, reporting success or the backend's error inline. A session shared IN from another
profile (resolved via the `owner` action on open) hides the share button — you can't re-share what you
don't own — and shows a "read-only · &lt;owner&gt;" badge. It all stays hidden in default deployments, so
nothing changes when profile-aware storage isn't active.
