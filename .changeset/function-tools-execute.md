---
"@matatbread/matbot-function-tools": patch
---

`tool_function` gains `{ action: 'execute' }` and drops `{ action: 'lambda' }`.

A lambda had to be written as a whole function — a head, a parameter list and a return type — none of
which it used: the parameters were a placeholder object nobody read, and the return type was a contract
nothing consumed, since a result is stringified on its way to every provider. That head was also the only
place the commonest mistake could be made, `(args) => { … }`: it survives the compile wrap, so it fails as
invalid TypeScript, and a first attempt spends a round discovering that. With no head there is nothing to
write an arrow in. `execute` therefore takes the BODY alone — `{ const xs = await tool.x({}); return
xs.length; }` — and the braces are required rather than conventional, because an unbraced arrow form is a
legal *expression statement*: it would compile, evaluate and discard the function, and return `undefined`,
arriving as a silent `null` indistinguishable from a body that chose to return nothing. A definition that
is not a block is refused with the working shape named.

`lambda` is removed rather than aliased: the only caller was one trigger, which is updated. It was an
executable form, so an alias would have kept both names — and the misleading one — in the description
forever, which is the cost the rename exists to remove.

`execute` is anonymous and one-shot, so it is never stored, never registered and not reachable from
`check`; it is type-checked against the live tool types on the same terms as a `define` (opt out with
`noTypeCheck`). `define` is unchanged, and the `definition` parameter now states the two shapes and their
one shared prohibition — no `=>` — where the call is written.
