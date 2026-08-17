// Type-check the browser UI (static/*.js) against the live `ToolContracts` — see static/matbot-ui.ts.
//
// Why this wrapper rather than a bare `tsc -p static`: the UI's tool types come from importing the
// plugin packages that declare them, which pulls those packages' TypeScript SOURCE into this program.
// They are authored against the repo's strict base config; this program is deliberately loose (the UI
// is untyped browser JS, and grading its DOM idioms is not what this gate is for). Under looser
// options a few of those sources report differently — `void | T` narrows differently without
// strictNullChecks, and a `never` appears where an exhaustive switch was proved — so they would fail a
// check that is not about them. Each of those packages is graded properly by its own `typecheck`
// script, under its own options. This gate's business is `static/`, so that is what it reports.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here      = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, '..', 'static');

const tsc = spawnSync(
  process.execPath,
  [resolve(here, '..', '..', '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
   '-p', staticDir, '--pretty', 'false'],
  { cwd: staticDir, encoding: 'utf8' },
);

if (tsc.error) {
  console.error(`[web-ui] could not run tsc: ${tsc.error.message}`);
  process.exit(2);
}

const lines = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.split('\n').filter(Boolean);
// `file(line,col): error TS1234: message`, optionally followed by indented elaboration lines that carry
// no file of their own — they inherit the verdict of the diagnostic they belong to. Anything else (a
// tsc crash, a bad config) has no file to attribute at all, so it is never filtered away.
const diagnostic = /^(.+?)\((\d+),(\d+)\): (error|warning) TS\d+:/;
const mine = [];
let keeping = true;
for (const l of lines) {
  const m = diagnostic.exec(l);
  if (m !== null)            keeping = resolve(staticDir, m[1]).startsWith(`${staticDir}/`);
  else if (/^\s/.test(l))    { if (keeping) mine.push(l); continue; }
  else                       keeping = true;
  if (keeping) mine.push(l);
}

if (mine.length > 0) {
  for (const l of mine) console.error(l);
  console.error(`\n[web-ui] ${mine.length} problem(s) in static/. A tool contract change reaches the UI here, not in the browser.`);
  process.exit(1);
}

console.log('[web-ui] static/ type-checks against the current tool contracts.');
