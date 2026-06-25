---
"@matatbread/matbot-frontend-web": patch
"@matatbread/matbot-cognition": patch
"@matatbread/matbot-web-principal-user": patch
"@matatbread/matbot-tool-docker-bash": patch
---

fix: correct misplaced workspace dependencies

Several plugins declared type-only `@matatbread/*` imports (the runtime coupling
is via the service registry, not the import) under `dependencies`, which made a
packed/published tarball try to install them from the registry:

- frontend-web: `matbot-skills` → devDependencies
- cognition: `matbot-skills`, `matbot-triggers` → devDependencies
- web-principal-user: `matbot-frontend-web` → devDependencies
- docker-bash: removed `matbot-tool-bash` (entirely unused; the "replaces bash"
  relationship is runtime via the registry, never imported)
