---
'@matatbread/matbot-tool-background': patch
---

`background` can run a job once at a stated time, and a long wait no longer spins.

**"Do this at nine tomorrow" had no expression.** `background` ran a prompt now, or every N minutes
forever; a one-shot appointment could only be faked as a recurring schedule suspended after its first
fire. It now takes `at` — an ISO-8601 date-time, or a duration from now ("90m", "2h", "3d") for a model
that cannot be sure of today's date — and returns the instant it resolved to, so the time the user is
told is the time the job will run rather than the words the model typed. Like a recurring schedule it is
persisted, listed and cancellable through `every_action` (its row reads `interval: "once"`, with the fire
time in `nextRun`), and it deletes itself once it has run. No `oneShot` flag: the ABSENCE of an interval
is what makes it one, exactly as it already is on this tool's own parameters, so nothing can disagree
with the interval beside it. `interval` and `at` together are refused rather than guessed at.

A time already in the past at creation is refused, naming the instant it resolved to — a model that got
the year wrong would otherwise fire instantly, which reads as the tool having ignored the time it was
given. A fire time that goes by while matbot is not running is honoured late on the next start: the
request stays true until it is met. A bare number is refused rather than handed to `Date.parse`, which
reads "5" as a year.

**`interval` and `at` are typed, not just validated.** Both carry template literal types matching the
regexes that admit them — `` `${number}${'ms'|'s'|'m'|'h'|'d'}` `` for a duration, an ISO date with an
optional time for an instant — so a composed function passing `interval: 'once a day'` or `at: 'tomorrow'`
is a compile error rather than a tool error at run time, and the model reads the accepted shape off the
rendered params instead of having to find the sentence about it. Approximate at the edges by construction
(`${number}` also admits `-5s`), which is why the executor still validates. The correspondence between
each regex and its type is asserted in exactly one place each — a narrowing `isDuration` guard, and one
cast on `toISOString()`, whose shape is fixed by specification — so nothing downstream is cast on faith:
the duration echoed back in the result is the narrowed input, and every date a schedule carries is minted
through the same helper. The two duplicate duration regexes collapsed into one on the way.

**Bug fix: a wait longer than ~24.8 days was a tight loop, not a long sleep.** `setTimeout` takes a
32-bit signed delay and clamps anything larger to 1ms, so a schedule that far out woke immediately and
went straight back round — "remind me next year" spinning against the store at full speed. Long waits are
now slept in chunks against a deadline, which also fixes the same latent exposure on a long recurring
interval and is the only form that survives the clock moving underneath it.
