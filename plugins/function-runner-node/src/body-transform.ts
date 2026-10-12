import { createRequire, stripTypeScriptTypes } from 'node:module';
import type TS from 'typescript';

/** What a rewritten `import(…)` resolves to. Private to this runner: it is bound in a wrapper of its own
 *  and the loader behind it arrives as an ordinary argument, so nothing outside needs to know the name —
 *  not the consumer that supplies the loader, not the type-check, and not the body's author. */
export const ROUTE = '__matbotImport$';

/**
 * Erase a body's types and route its `import(…)` calls onto {@link ROUTE} — the whole transform the node
 * runner applies before compiling, in one pass of one compiler.
 *
 * A parser rather than a scan over the text because the question — is this `import(` in code, or inside a
 * string, a template, a comment or a regex literal? — is not answerable by looking at the candidate. It
 * needs the previous significant token, and two of those cases are undecidable without having parsed:
 * a `/` after `)` may follow `if (…)` or `(a + b)`, and after `}` it may end a block or an object
 * literal. A wrong answer does not misread one token, it desyncs the reader, so a quote further along
 * swallows an `import(` that neither reading mentions — leaving an import with no gate in front of it and
 * nothing reporting that. The parser also tells a method shorthand named `import` and a type-position
 * `import('x').Foo` from a call, both of which had to be refused outright before.
 *
 * TypeScript's parser, because it is already in this toolchain and is the one whose idea of the language
 * matches what the check gate grades. Loaded with `createRequire` on first use — synchronously, which is
 * what keeps `compile` synchronous and the recompile-on-swap path free of an await — and the ~250ms is
 * paid once, by the first body that compiles, not at startup.
 *
 * Erasure is node's own `stripTypeScriptTypes`, not this compiler's `transpileModule`: the stripper BLANKS
 * types in place, so every offset and line number in the erased text is the one the author wrote and the
 * one the check gate reported against. `transpileModule` reprints from the AST — it inserts a
 * `"use strict"` prologue and normalises formatting — which would leave a runtime error pointing at a line
 * nobody wrote.
 */
export function transformBody(source: string): string {
  // `source` is a self-contained function expression, so both steps below take it as it stands — which is
  // why the contract hands one over rather than a body plus its parameter names.
  let erased: string;
  try { erased = stripTypeScriptTypes(source); }
  catch (e) { throw new Error(`not valid TypeScript (${e instanceof Error ? e.message : String(e)})`); }

  const ts = load();
  // Parsed as JS, the erasure having already happened: one language for this pass to understand.
  const file = ts.createSourceFile('tool_function', erased, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  // A parse error here is a bug in this harness, not in the body: the erasure above already succeeded, so
  // the text was valid TypeScript a moment ago. It matters anyway because TypeScript's parser is error
  // TOLERANT — it returns a tree for input it could not make sense of, and a call inside the part it
  // gave up on is a call this never sees. So an error THROWS rather than returning the source unchanged:
  // returning it would hand back ungated imports, the one direction this must not fail in.
  //
  // `parseDiagnostics` is internal to TypeScript's own types, hence the reach. Its ABSENCE is treated the
  // same way as an error for the same reason: unable to confirm the body parsed cleanly, this refuses
  // rather than trusting a tree it cannot vouch for. A rename inside TypeScript then surfaces on the
  // first body anyone compiles, instead of quietly widening what gets past the gate.
  const syntactic = (file as unknown as { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics;
  if (!Array.isArray(syntactic)) {
    throw new Error("could not read TypeScript's parse diagnostics, so this body's imports cannot be gated. This is a matbot bug — report the TypeScript version.");
  }
  const bad = syntactic[0];
  if (bad !== undefined) {
    throw new Error(`could not parse the erased body to find its imports: ${ts.flattenDiagnosticMessageText(bad.messageText, ' ')}`);
  }

  const spans: Array<readonly [number, number]> = [];
  const walk = (node: TS.Node): void => {
    // The callee is the `import` keyword itself only in a dynamic-import CALL. An `import.meta` is a
    // MetaProperty, a type-position `import('x').Foo` an ImportTypeNode, and `o.import(x)` a property
    // access — none of them match, so none of them are touched.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      spans.push([node.expression.getStart(file), node.expression.end]);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);

  // Only the keyword is replaced, so the arguments reach the loader as written — a second one carrying
  // import attributes included. Back to front, so an earlier replacement cannot move a later span.
  let code = erased;
  for (const [start, end] of spans.reverse()) code = code.slice(0, start) + ROUTE + code.slice(end);
  return code;
}

// Lazily, and not at module load: an install that never defines a tool_function should not pay for the
// compiler, and nothing else in this process needs it.
let ts: typeof TS | undefined;
function load(): typeof TS {
  if (ts === undefined) ts = createRequire(import.meta.url)('typescript') as typeof TS;
  return ts;
}
