---
'@matatbread/matbot-tool-docker-bash': patch
---

docker-bash: default image is now `node:24-bookworm`, plus a `bash_config` `pull` action

The container is created from `node:24-bookworm` instead of `ubuntu:24.04`, so Node 24 and npm are
preinstalled and a script no longer has to `apt-get install` a toolchain before it can run anything
JavaScript. Still Debian, so `apt` remains the package manager and existing scripts are unaffected.

`bash_config { action: 'pull' }` fetches the configured image and recreates the container from it,
streaming the pull's progress as it goes (a first pull is ~1GB, which `restart` would have spent in
silence). It recreates unconditionally: an image already up to date says nothing about which image
the *existing* container was built from, which is exactly the case after this default moves.

An existing `matbot-bash` container keeps whatever image it was created from — the container is only
created when absent — so adopting the new default is one `bash_config { action: 'pull' }`.
