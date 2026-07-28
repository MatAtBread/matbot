---
"@matatbread/matbot-tool-bash": patch
---

Drop the legacy in-tool docker executor; correct what the working directory actually is.

- **Removed `DockerConfig` / `createBashTool(docker?)`.** The docker branch was unreachable — nothing in
  the tree ever called `createBashTool` with a config, so the plugin only ever registered the local
  executor. It was also strictly worse than the plugin that supersedes it: an ephemeral `docker run --rm`
  per call with no output cap, no process-group kill, and no persistence.
  `@matatbread/matbot-tool-docker-bash` is the sandboxed implementation — same tool name, same input
  shape, plus a persistent container, `projectRoot` read-only, an output byte cap, and a `bash_config`
  tool. `bashTool` is now a plain constant.
- **The working directory is a scratch directory, not "the workspace".** The removed executor mounted
  `ctx.workdir` at `/workspace` under the comment "mount the session workspace so scripts can read/write
  workspace files" — untrue: `ctx.workdir` is a private scratch area for temporary scripts and
  intermediate data, not the file store behind the Workspace panel, and nothing written there is visible
  to the user, servable over HTTP, or shareable. The tool description and the `cwd` parameter said the
  same thing and now say what it is, and that user-facing files belong in whichever tool manages stored
  files. This was actively teaching the model to write a requested file into a place the user can never
  see it.
