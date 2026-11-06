---
"@matatbread/matbot-core": patch
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-background-jobs": patch
"@matatbread/matbot-function-tools": patch
"@matatbread/matbot-tool-types": patch
"@matatbread/matbot-triggers": patch
---

`single_turn` runs a turn with tools (`tools: true`): a full agent turn within the calling session, returning its text and tool calls. `turns: [...]` runs several at once and returns their results in order. Triggers do not judge such a turn. `ToolContract` gains an optional third argument, the exact call signature `ToolProxy` declares, for a result shaped by the call's own params. `subTurnDepth` and `SUB_TURN_CREATOR` say how deep a sub-turn is. `runEphemeralTurn` takes `initialMessages`, and `drainEphemeralTurn` runs one to the end and reports how it ended. A model is now shown an id beside each attachment, which `single_turn`'s `attach` accepts. `invokeTool` carries `appender`, so a composed call on an ephemeral run reports where the run reports.
