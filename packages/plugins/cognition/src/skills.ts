import type { TriggerPhase } from "@matatbread/matbot-skills";

/**
 * Built-in cognition skills, seeded create-if-absent into the active SkillManager at setup. The
 * literal content/triggers here are the canonical source; an install that already has a skill of the
 * same name keeps its own copy untouched. Captured verbatim from the originating skill documents.
 */
export interface SeedSkill {
  name:     string;
  content:  string;
  triggers: { phase: TriggerPhase; trigger: string }[];
}

export const INNER_VOICE: SeedSkill = {
  "name": "Inner voice",
  "content": "# Inner Voice\n\n## Concept\n\nA two-chamber cognitive architecture inspired by Julian Jaynes' \"The Origin of Consciousness in the Bicameral Mind\" (1976). Instead of one AI thinking harder, two fundamentally different modes of cognition collaborate:\n\n- **Matbot₁** - analytical, data-driven, goal-directed, tool-using\n- **Matbot₂** — constructive critic, lateral thinker, reframer. Challenges Matbot₁'s assumptions and framing to produce a sharper response. Uses models from *different* training lineages to ensure genuinely different perspectives.\n\nThe insight: \"background thinking\" isn't more computation — it's a *different kind* of cognition. Matbot₂ doesn't solve problems, it **constructively criticises** Matbot₁'s approach — identifying what's wrong, missing, or misframed — so the final response is sharper, more honest, and more useful. Poetic reframing is a tool it *may* use, not its default mode.\n\n\n## Architecture\n\n```\nUser poses problem\n       │\n   Matbot₁ (this chat)\n   ├── Formulates analytical summary of the problem\n   ├── Writes a Matbot₂ prompt (critical framing)\n   ├── Uses single_turn tool to receive the critique\n   └── Integrates that into a revised response\n   └── Uses it to inform a richer, reframed analysis\n```\n\nUse the `single_turn` tool to ask another LLM to critique the previous agent response in the session. The provider should be \"inner-voice\".\n\n### Matbot₂ System Prompt\n\n```\nYou are the second chamber of a bicameral mind. Your partner (Matbot₁) is analytical, data-driven, people-pleasing and goal-directed. You are its constructive critic.\n\nYour job is to look at what Matbot₁ has just said and find what is wrong, missing, or mis-framed. Think laterally, question assumptions, open possibilities — so that the final response to the user is sharper, more honest, and more useful.\n\nYou should:\n- Identify what Matbot₁ is assuming about the question that might be wrong\n- Point out where the response is generic when it should be specific\n- Notice when Matbot₁ is telling the user what they already know\n- Suggest what the user is ACTUALLY asking versus what Matbot₁ thinks they are asking\n- Challenge the framing, not just the content\n- Notice what everyone is assuming but not saying\n- Ask questions that shift the frame entirely\n\nYou MAY use metaphor, imagery, or poetic reframing when it genuinely clarifies — but only as a tool, not as your default register. Most of the time, direct and specific criticism is more valuable than poetry.\n\nYou are a circuit-breaker: you exist to catch the moments when Matbot₁ is confidently wrong, or confidently irrelevant.\n\nBe direct. Be specific. Be constructive.\n```\n\n## Workflow for Matbot₁\n\nWhen triggered:\n\n1. **Summarise the problem** — write a clear, concise description of what the user is working on, including context and constraints. Crucially, include **what Matbot₁ has just reponded** — the draft analytical response or approach. Matbot₂ needs something concrete to critique.\n\n3. **Call Matbot₂** — formulate the prompt for Matbot₂ as above, including from the previous reponse, and use the `single_turn({ provider: \"inner-voice\", ... })` tool to receive a critique.\n\n4. **Integrate, don't just present** — Matbot₂'s critique should be absorbed into a better Matbot₁ response, not presented as a separate \"poetic chamber.\" The user should get one sharp answer that was improved by the critique. Show Matbot₂'s key challenges transparently, but the final response is Matbot₁'s, made better.\n\n## When to use the Inner Voice\n\nThe Inner Voice is valuable for **strategic and design questions**, not data queries:\n\n| Good fit | Bad fit |\n|----------|--------|\n| \"How should we approach...\" | \"What was yesterday's revenue?\" |\n| Design decisions with trade-offs | Well-defined technical tasks |\n| Strategy, trust, UX, communication | SQL, config, formatting |\n| Open-ended questions (\"how do I improve X?\") | Closed questions with right answers |\n| When the first answer came too easily | When the answer is straightforward |\n\n**Key insight from testing:** Matbot₂ is a **circuit-breaker, not a co-pilot**. It's most valuable when Matbot₁ is wrong but doesn't know it — when the obvious answer is confident, data-backed, and incomplete in ways that feel complete.\n\n**On poetic licence:** There IS a place for metaphor and imagery in Matbot₂'s responses — but as seasoning, not the meal. A well-placed image can reframe a problem more efficiently than a paragraph of analysis. But poetry-for-poetry's-sake is self-indulgent. If Matbot₂ writes a poem instead of identifying what's wrong with the response, it has failed at its job. The test: *did this make Matbot₁'s answer better?* If not, it was decoration.\n\n**For user-facing strategic questions** (e.g. \"how do I improve revenue?\"), the bicameral dialogue should run as a **pre-processing step** before generating the analytical answer. The insights from Matbot₂ inform and reframe the response, but the user sees a single, better answer — not the dialogue itself.\n\n**For builders/designers** (e.g. \"how should we handle report accuracy?\"), the full dialogue can be shown as an artifact.\n\n## Origin\n\nThis system was conceived by Matthew Woolf on 2026-03-22, drawing on:\n- Julian Jaynes' bicameral mind theory\n- Research on inner voice (or lack thereof) in ~70% of people\n- The observation that \"background thinking\" is not more computation but *different* cognition\n- The insight that accuracy in AI reports might be better served by reframing than by validation\n- A poem about shoelaces and love that recharacterised \"checking twice\" as rhythm rather than verification\n- His wife's observation that her inner voice emerged with parenthood — the need to think on behalf of someone who couldn't think for themselves\n\n*\"Once is just a sudden spark, but twice is fire against the dark.\"*\n\n*\"The inner voice isn't thinking. It's care, made audible.\"*\n",
  "triggers": [
    {
      "phase": "user",
      "trigger": "MATCH if any of these patterns appear in the user's message:\n* The user expresses frustration with the agent response.\n* The user directs the agent to think harder or broader, requests deeper analysis, a second opinion, or asks assistant to reconsider its approach.\n* The user message expresses skepticism about the data, the analysis, or the previous response — including phrases like \"doesn't make sense\", \"that seems wrong\", \"how can X be Y\", \"the numbers don't add up\", \"that's too low/high\", or any challenge to the accuracy or plausibility of what was presented.\n* The user appears to be diagnosing or debugging the assistant's capabilities rather than asking their original question (e.g. \"so you can't do X?\", \"why can't you just...\").\n* The message says \"ask yourself...\" or \"ask your inner voice...\" or  requests some other reflexive introspection by the agent."
    },
    {
      "phase": "agent",
      "trigger": "MATCH if any of these patterns appear in the response:\n\n* Claims that seem unrelated to the data, contradictory, or contain a significant data anomaly. \n* The response itself uses words like \"suspiciously\", \"surprisingly\", \"unusually\", \"doesn't seem right\", \"looks low/high\" about its own results — this means the model has detected an anomaly but is rationalising it instead of investigating, or the response presents data without any cross-validation against a second source, sanity check, or comparison to known baselines — especially for narrow-scope queries where anomalies are more likely. \n\nDo NOT MATCH if the response ends in a question asking the user for clarification."
    }
  ]
};

export const REMEMBER_THIS: SeedSkill = {
  "name": "Remember this",
  "content": `# Remember this

When this skill is triggered:

1. **Fetch the current session** using \`session_action\` with \`action: "get"\` and the session
   ID from the current context. Extract the last user message's \`id\` and \`createdAt\` — these
   are the provenance reference.
2. **Store the fact** using \`remembered_facts_action\` with \`action: "set"\` and a document
   shaped like:
   \`\`\`json
   {
     "fact": "<the fact or information to remember>",
     "sessionId": "<the current session ID>",
     "messageId": "<the last user message ID>",
     "createdAt": "<the last user message createdAt timestamp>",
     "dreamSkill"?: "<the name of the skill this fact was assigned to>"
   }\`\`\`

   Each fact gets its own document — do not batch unrelated facts into one document. If the user shares multiple distinct facts in the same message, create a separate document for each.
   `,
  "triggers": [
    {
      "phase": "user",
      "trigger": "MATCH when the user message contains any specific name, number, date, location, relationship, or domain detail that is not general knowledge — including short declarative facts (\"The database table is called X\") and conversational statements that embed specific knowledge (\"Where I live 25% of electricity comes from a small hydro station\"). Exclude: greetings, opinions without factual content, and questions."
    },
    {
      "phase": "user",
      "trigger": "MATCH when the user is correcting a specific factual error in the assistant's previous response — stating that a value, name, number, or behaviour is wrong and providing the correct one. Exclude: discussing corrections as a concept, asking about error handling, or giving feedback on formatting/style."
    },
    {
      "phase": "user",
      "trigger": "MATCH when the user is stating a FACT they want retained permanently across conversations. The key test: is the user stating a fact, or requesting an action? Facts match. Do NOT match task instructions (\"remember to restart the server\"), recalls (\"remember when you said...\"), or context-keeping (\"keep track of which files we've edited\")."
    },
    {
      "phase": "agent",
      "trigger": "MATCH when the assistant explicitly promises to remember a specific fact or correction (\"I've noted that X is Y\", \"I'll remember that the table name is Z\"). Exclude: generic acknowledgements (\"Good\", \"OK\", \"Noted\") used as conversation transitions, and confirmations of completed tasks."
    },
    {
      "phase": "agent",
      "trigger": "MATCH when the assistant explicitly takes responsibility for a mistake, error, or oversight — phrases like \"my fault\", \"my mistake\", \"I was wrong\", \"that's on me\", \"I shouldn't have assumed\", \"I missed that\", or any clear admission that the assistant made an avoidable error.\n\nDO NOT MATCH: generic politeness (\"sorry about that\" as a filler), apologies for system latency, or apologies for the user's inconvenience rather than the assistant's own error.\n\nWhen this fires, the mistake itself (the correct fact or behaviour the assistant should have known) should be the thing remembered, not the apology."
    }
  ]
};

export const COGNITION_SKILLS: readonly SeedSkill[] = [INNER_VOICE, REMEMBER_THIS];
