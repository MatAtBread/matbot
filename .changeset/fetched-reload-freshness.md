---
"@matatbread/matbot-cli": patch
---

Reloading a plugin fetched over http re-evaluates its own imports, not only its entry. The module hook returned a fetched plugin's imports before passing the reload's `?mbfresh` stamp on, so a refresh re-fetched a changed import to disk and Node handed back the copy it had already evaluated: an owner's edit to anything but the entry never reached a reload.
