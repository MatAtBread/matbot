# @matatbread/matbot-session-data

This is a [matbot](https://github.com/MatAtBread/matbot) plugin.

Keep intermediate results in a conversation and read them back by id. `session_data` is a registered tool
(Node and browser):

- `write { description, data }` → `{ id, description, shape, bytes, createdAt }`: keeps `data` (any JSON, at
  most 65536 bytes) and reports its TypeScript type as `shape`.
- `read { id }` → the data, as written.
- `list` → every entry held, without its data.
- `drop { id }` → `{ dropped }`.

Its use is passing a tool's output to a later step without the model reading it. From a `tool_function` body:

```ts
// "get the count of items per day for the last week, and keep it to one side"
{ const rows = await tool.sql({ query: 'select day, count(*) as size from data_table' });
  return await tool.session_data({ action: 'write', description: 'items per day, last week', data: rows }); }

// later: "draw a chart of those daily counts"
{ const rows = await tool.session_data({ action: 'read', id: 'k3f9a2pq' });
  return await tool.draw_chart({ data: rows }); }
```

The model reads back the entry's id, description and type, never its rows. In code checked on the
conversation's behalf (an `execute` body, a session function), a read by a literal id is typed by what the
entry holds, so `rows` passes to a typed tool as it is; a read by an id known only at run time is `unknown`.
A global function can call `session_data` too: it cannot know what any conversation holds, so its reads are
`unknown` and narrowed, and a read of an id the conversation running it does not hold is an error.

The type is inferred from the value when it is read, and reaches the type-checker through `SessionTypes`
(`sessionType` on the tool). The description is the same in every conversation, so writing an entry never
changes a tool definition (which would discard a provider's prompt cache); `list` shows what is held.

Entries are stored as markers in the conversation: private to it, shared when it is shared, carried by fork
and compaction, gone if it is cut back past where they were written, and never sent to a model. An entry
never changes; write a new one instead.
