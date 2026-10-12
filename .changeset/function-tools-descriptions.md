---
"@matatbread/matbot-function-tools": patch
---

`tool_function`'s descriptions say what the tool actually is. The description is where a model reads *how*
to call it, so it now leads with the action table, the parameter relations and the body's environment, and
drops the long `WHEN TO USE THIS` argument (that belongs in the system prompt, which is read before the
tool is considered). The `ACTIONS` table states per action what is required, what is optional and what is
persisted — `scope` is `define`-only, `definition` is function source for define/lambda but module source
for package, `name` is the function name except beside `package`, and `package` is a selector for
check/remove rather than the define action. The body is described as a bare async function, not a module:
the three injected bindings, and (node only) `await import('node:…')` with `require`, `module`, `exports`,
`__dirname`, `__filename` and `import.meta` rejected. `check`'s `label` vocabulary now names every rule a
finding can carry — a tsc code such as `TS2339`, or the structural rules `CAST-GATE`, `ENV-GATE`,
`SHADOWED` and `PARSE` — rather than only `CAST-GATE`. A `session` function is stated to be stored in the
conversation, so it survives a restart, a fork, a cut and a compact, instead of reading as ephemeral. The
`definition` parameter says outright that the syntax is method shorthand — there is no `=>`, which is the
commonest first attempt, and a leading `async` or `function` is tolerated and stripped.

The system-prompt contribution is broadened from lambdas to the capability: it is headed `tool_function`
rather than `{ action: 'lambda' }`, covers the three lifetimes a function can have (`lambda`, session
scope, global scope), and qualifies platform access to node. It is deliberately shorter, since it is paid
for in every conversation whether a function suits the work or not, and length there biases a model toward
one on a weak case.
