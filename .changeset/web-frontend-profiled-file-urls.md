---
"@matatbread/matbot-frontend-web": patch
---

Serve profile-partitioned files by URL. A browser GET (an `<img>`, a download link) can't send the
`x-matbot-principal` header, so `url_for_resource` now bakes the current principal into the path as a
leading `~<principal>` segment when profile-aware storage is active, and the `GET /files` route parses it
back out and reads under that principal. `~` is excluded from principal ids and namespaces, so the
segment is unambiguous; without profiles the URL is byte-identical to before.

Also fixes a deep-link bug: the `hashchange` handler didn't strip a `#<profile>:` prefix the way the
load-time parser does, so navigating to a profile deep-link mid-session treated `profile:session` as a
session id. It now splits the profile off — switching (reload) when it differs from the active one,
stripping it in place when it matches — before parsing the session fragment.
