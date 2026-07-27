---
"@matatbread/matbot-triggers": patch
---

Agent-surface `followup` firings now leave an audit trail. A `retract` fire was already traced (a
`retract-fired` marker naming the trigger and each matched condition's index/kind/rule/`why`), but a
`followup` fire — keep the response, resubmit the tool's output as a robo turn — recorded nothing:
no marker, no matched condition, no classifier rationale. The steer simply appeared, so neither a
builder auditing the session nor the model itself could say which rule judged the response or on what
evidence; the model's backwards guess at the reason could then re-match the same rule, looping with
no record of the recursion.

A `followup-fired` marker (`creator: 'triggers'`, `surface: 'agent'`) now rides with the resubmit,
carrying the same `triggers: [{ id, matched: [{ index, kind, rule, why }] }]` payload the user-surface
`user-insitu-fired` / `user-retract-fired` markers already carry. Like those it is LLM-invisible
(markers are elided from submission, persisted unchanged) and, unlike `retract-fired`, is not read
back by the retract convergence guard — it is a trace, not a control signal. `retract-fired` gains the
`surface: 'agent'` tag for symmetry with the user-phase markers.
