# @matatbread/matbot-tool-bash

## 0.3.10

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10

## 0.3.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.9

## 0.3.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8

## 0.3.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5

- 0986fee: Drop the legacy in-tool docker executor; correct what the working directory actually is.

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

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [c3a1b00]
  - @matatbread/matbot-plugin-api@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2

## 0.2.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8

## 0.2.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6

## 0.2.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.7

## 0.1.6

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.4

## 0.1.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.1
