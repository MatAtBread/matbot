# @matatbread/matbot-parallel-map-reduce

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

`parallel_map_reduce` asks one question of each item of a set, each as its own sub-agent turn (`single_turn`),
run concurrently, and has the conversation combine the answers in a later turn (Node and browser).

```json
{ "mapPrompt":    "Which Node version does the repository below target? Look at package.json, .nvmrc and CI config. Reply with the version and the file that says so.",
  "items":        ["/repos/api-server", "/repos/web"],
  "reducePrompt": "List the repositories above still on Node 18 or older, and what to change in each." }
```

Each turn is asked `mapPrompt`, then its item, and sees nothing else: whatever a turn should know about the
wider task belongs in `mapPrompt`. An item is text, or `{ "attach": "<attachment id>" }` for a file to look
at (an attachment of the conversation, or with `tools: false` a stored file by name). Every turn opens with
the same text, so a provider's prompt cache serves the shared part. For hundreds of items, build the list in
code rather than writing it out:

```ts
const s = await tool.session_action({ action: 'list' });
return tool.parallel_map_reduce({
  mapPrompt:    'Read the conversation named below and suggest 1–3 topic tags. Reply with the tags only.',
  items:        s.items.map(x => `Session ID: ${x.id}`),
  reducePrompt: 'Group the conversations above by their tags.',
});
```

It returns at once with `{ wave, started, session }`. The answers do not come back to the caller:

- As each turn finishes, its answer is appended to the conversation as `[w-ab3k 2/2 /repos/web] …`, named by
  its item (shortened to 60 characters; the index tells two alike apart). A failed turn is appended too, so
  a missing answer is never mistaken for one that was not asked.
- Once every turn has answered, `reducePrompt` is asked in the conversation (a robo-submit, `queue`),
  prefixed with the tally — `[w-ab3k: 2 of 2 answered]`, or which items failed. It is answered with every
  answer in front of it, so ask the map turns for short answers.

The conversation is the buffer: the reduce turn reads the answers as history, and retrieves nothing.

- **`tools`** defaults to true, because a map turn exists to do reading the caller should not: a turn told to
  read a file it cannot open answers from nothing. `false` makes each turn one request with no tools.
- **`session`** names the conversation to report to. By default it is the one the call is made from, or for
  a background job the conversation it was created with. A call with no conversation of its own (the HTTP
  tool door) must name one.
- **Concurrency**: at most 4 turns of a wave run at once; the rest wait.
- **Stopping**: the turns run under the calling turn's signal, so stopping that turn stops the wave. What
  finished stays in the conversation, a line says the wave stopped, and the reduce is not asked.

Use it when each item needs reading or work far larger than its answer. Not for items that constrain one
another (an itinerary, a budget, a single argument), and not for a few small items a model can answer
directly. Where an answer is mechanical (a field read from a templated document), a `tool_function` body
that extracts it in code is cheaper still.

What a sub-turn's tools record as markers (`session_data`, a session function) is not kept: the call that
could carry them into the session has returned before the turns finish.
