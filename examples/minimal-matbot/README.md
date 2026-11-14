# minimal-matbot

The smallest useful matbot: a machine built from `@matatbread/matbot-core` alone, which reads a prompt
from stdin, runs one turn against the [chatjimmy](../../plugins/providers/chatjimmy) provider (a hosted
llama endpoint that needs no API key) and streams the reply to stdout.

```sh
pnpm install            # once, from the repository root
cd examples/minimal-matbot
echo "Why is the sky blue?" | pnpm start
```

## What is in it

- **[index.ts](index.ts)** builds the machine with `assembleMachine`. A host supplies:
  - **Carriers.** These say whose behalf the work is done on. `createConstantPrincipalCarrier` gives one
    principal for the whole process. A server would use `@matatbread/matbot-host-node`'s
    `AsyncLocalStorage` carrier and call `runAs` for each request.
  - **Storage.** `MemoryStorageBackend` keeps nothing after the process exits.
  - **A vault**, for `${NAME}` secrets. Here it is empty, since chatjimmy needs no key.
  - **The providers.** One here, with tool calling switched off, so this is a plain question and answer.
  - **`loadPlugin`.** A provider's `module` is a plugin and is loaded through this. The example resolves
    the package name with `import.meta.resolve`, from its own location, because that is where the
    package is installed.
- **[register.js](register.js)** has the two Node module hooks that matbot's packages need, because they
  are published as TypeScript source. They are written out only so the example needs nothing but `core`.
  Most applications run with `node --import @matatbread/matbot-host-node/register` instead.

Each turn's events are an `AsyncIterable`. This example prints the `text-delta` events and exits at
`idle`.

## Going further

- **More than one user, or plugins loaded from disk:** add `@matatbread/matbot-host-node`. **Files kept
  between runs:** boot on `FilesystemStorageBackend` from `@matatbread/matbot-storage-filesystem`. See *Embedding matbot in a Node application* in
  [docs/DEVELOPING.md](../../docs/DEVELOPING.md), and
  [apps/cli/test/embedder.test.ts](../../apps/cli/test/embedder.test.ts).
- **Tools:** call `services.loadPlugin('@matatbread/matbot-tool-whoami')` after adding the package as a
  dependency. chatjimmy's endpoint has a window of about 6k tokens, so for anything real choose a
  provider with a larger one.
