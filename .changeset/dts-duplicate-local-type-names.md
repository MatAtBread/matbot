---
'@matatbread/matbot-tool-types': patch
---

The derived tool dts survives two plugins declaring a same-named local type.

Bundling flattens every referenced workspace type into one scope, but the bundle was keyed by declaration
identity, so two file-local types sharing a name were emitted side by side. The artefact then failed to
compile (`TS2300`) and both references resolved to an *error* type — which is assignable to anything, so
the narrowing the contract exists to provide was silently gone wherever a generator was graded against it.

The colliding pair is real and deliberate: `background` and `edit-session` each declare a `SkipKind`, and
`background` records why it is not shared ("two plugins agreeing on three words is not yet an abstraction
worth a package"). Both plugins' comments then tell callers to branch on `kind` and never on the prose —
exactly the affordance that was lost. Renaming either type in source would not have been a fix, only a
deferral of the next collision, so the generator represents the case instead: the first symbol to claim a
name keeps it, later ones are alpha-renamed (`SkipKind$1`), and every reference is rewritten to match.

Keyed by SYMBOL rather than declaration, because a merged interface is several declarations of one symbol
and renaming those apart would break the merge. Names already taken by a plugin-api import are reserved up
front — which of those ends up imported is not known until the walk finishes, and a needless `$1` is
cosmetic where a collision is fatal. Rewriting each reference also settles the local spelling of an
`import { X as Y }`, which previously emitted a name the bundle never declared.

Nothing in the repo compiled the generator's output, which is why this surfaced downstream rather than in
CI: `typecheck` builds each plugin separately so two file-local types never meet, `check:contracts` never
compiles the dts, and `checkSnippetAgainst` deliberately drops every diagnostic inside the ambient prefix
on the grounds that a broken prefix is our bug and not the snippet's — true, and precisely why it was
inaudible. A test now compiles the emitted dts as source, which is the assertion that separates "the
contracts resolve" from "the contracts appear to resolve".
