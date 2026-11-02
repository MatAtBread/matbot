---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-core": patch
"@matatbread/matbot-gate-fs-node": patch
---

`gate_action deny` adds a standing denial, asking the user every time, for what is never prompted for because a broader allow covers it — one file inside a granted directory. Forgetting a denial is asked every time too. The default gate now ranks the answer nearest the act first, so a denial of a file or subdirectory refuses it inside a directory granted to one function or to any. gate-fs-node offers the file for any function. `PermissionRequest.lifetimes: []` means "ask every time". `PermissionRequest.answers` names the two answers where "Allow" would misread (Deny / Cancel); a request asked every time is drawn as those two buttons alone.
