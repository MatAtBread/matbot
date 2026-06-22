# Why triggers exist (the rationale)

This is the *why* behind the triggers subsystem (`@matatbread/matbot-triggers`), the `kind` model,
and the skills-as-tools framing. The mechanics are documented in `CLAUDE.md`; this is the motivation,
so the design isn't re-litigated from scratch.

## The origin problem

matbot is a ground-up rewrite of an analytics chatbot that had **~95 skills in a system-prompt
catalogue**, answering questions over terabytes of data. Four failure modes drove the design:

1. **Context bloat** — stuffing everything into the prompt.
2. **Attention dilution** — a long, always-on prompt is binding on turn 1 and background hum by turn 3.
3. **Users re-stating "facts" repeatedly** — the model wouldn't retain what an expert kept telling it.
4. **Over-confident persistence** — the model digging into an interpretation an expert *knows* is wrong.

## The spine: a discretion-reduction gradient

Triggers are **not** a generic "fire a tool on a condition" feature. They are one stop on a gradient
that progressively removes the LLM's discretion over things experts know to be true:

> skill (pure discretion — LLM may ignore) → trigger-*forced consideration* → trigger-*fired tool*
> (it just happens) → **compiled skill-as-tool** (expert fact in code the LLM can't argue with)

Each step right takes a judgement the model keeps getting wrong and moves it somewhere more reliable.
Out-of-band execution (the system runs the consequence, the LLM gets no vote) is the **aligned**
default; instructing the model to call the tool itself hands discretion back at the last step.

## JIT delivery & attention

The deepest frame: *both* halves of triggers are **just-in-time, in-context delivery of guidance that
decays when placed statically.** The enemy on both sides is the same — long, general, out-of-context,
attentionally-dead instructions. Triggers convert "present but ignored" → "absent until relevant, then
salient." The classifier's **separate, context-free, single-turn eval** is the same move applied to
detection: give one guardrail undivided attention on a focused rubric instead of making it compete
inside a monolithic prompt — decompose one broadcast prompt into N narrowcast evaluations.

## The user/agent asymmetry (it's the gradient, not a bug)

- **user-phase = routing knowledge *in*.** "Asked about fill-rates → load Bidmax." This is what killed
  the 95-skill catalogue.
- **agent-phase = re-asserting *process*** — the mirror of routing, for how the model works rather than
  what it knows. Most of these are **soft** ("widen scope", "cross-validate two sources", "test the
  counterfactual" — Inner Voice / Verify Assumptions / Bicameral). They are the **"expert over your
  shoulder"**: doing automatically what an expert user does by hand (pushing back on a generic or
  over-confident answer) *when the actual user is a non-expert who won't*. This is tractable because
  genericness has surface tells legible to an independent reader (the classifier didn't write the
  answer), unlike subtle factual wrongness. Hard answer-corrections (`dwell`→`pgdwell`) are the
  *unrepresentative* extreme, not the norm.

## Skills are a special case of tools

A trigger names a **tool**, not a skill. Firing a skill is just `invoke: skill_action({ action: 'use' })`.
"Apply a skill" is the specialization; "call a tool" is the general case — which collapsed the old
`tool → skill → tool` indirection and let everything ride one mechanism.

## The endgame: the skills compiler

Play to the LLM's strength: **writing code beats following procedures.** A prose skill is a program
written in English with the LLM as its stochastic interpreter, paying attention-rent every turn — and
its data-prep / conditional-output parts are pure burden. So the compiler is a **split**, not a
translation: the code-shaped core → a deterministic TS tool; the irreducible residue (when it applies,
framing) → a trigger condition + thin directive. Crucially, compilation **relocates** the LLM, it
doesn't remove it — TS orchestrates the boring high-volume work and embeds focused `singleTurn`
judgement calls exactly where English judgement is genuinely needed (a clean, low-context seat). Two
reasons to compile: attention/reliability (model-dependent, fades as context windows improve) and
determinism/cost/auditability (permanent).

## How the mechanism serves this

- **The `kind` model (ephemeral / contextual / retract / followup)** = the honest ways a
  system-executed consequence lands, replacing the v1 "robo message" hack (text-into-transcript).
  matbot has a neutral session format, so the native primitive is *structured*, not injected prose.
  The two user-surface kinds are an ephemeral/durable pair — inform just this turn (`ephemeral`, the
  former `augment`) vs. fold into the session for good (`contextual`) — and the two agent-surface kinds
  remove agent discretion to differing degrees (`retract` / `followup`).
- **Retraction-as-marker + redo** = the strongest agent-side discretion removal: a wrong answer is
  *superseded*, not politely re-asked.
- **Fences, the re-fire guards, suppression markers, the retraction UI** = keeping the mechanism
  **observable and reason-about-able** — the hard constraint that whoever writes triggers (human or
  LLM) must be able to reason about them. Hence: no silent suppression, nuance lives in the rubric not
  a confidence axis, and the precedence rule fits in one sentence.

**In one line:** deliver the right knowledge and the right process exactly when they're relevant,
execute them out-of-band to take them off the model's plate, and keep pushing the stable, expert-known
parts down the gradient toward code — with skills-as-tools as the single abstraction and the skills
compiler as the destination.
