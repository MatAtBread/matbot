/**
 * What a skill is, for every dream-time prompt that decides what goes into one. Stated by how a skill is
 * REACHED, because a skill nothing reaches is never consulted: the test for a subject is whether a user's
 * message could name it. One text, so the ranker, merger, clusterer and writer cannot drift apart.
 */
export const SKILL_DEFINITION = `
What a skill is: a skill is consulted only when something reaches it, and most are reached by search. When a user's message names a subject, the assistant searches its skills for that term and reads the whole skill it finds, so the term arrives inside a broader context it can reason about. So a skill is one of:
- INFORMATION on one subject a user's message could name: a person, a place, a household, a device or system in the user's world, an account, a project, an interest. It holds what is known about that subject that the model could not know from its training. The test: you can write the message from the user that would call for it.
- A PROCEDURE: how to get something done here, as steps, or conventions for using tools and features together.
A skill that is found is read whole into the conversation and cannot be taken out again, so a skill that comes up for messages it does not answer does more harm than one that is missed: a user can always ask for more. Keep a subject specific, and never widen one to take in more.
Not skill material, wherever it would be filed:
- what the assistant's own software can report about itself: its tools, plugins, settings, models and providers, versions, sessions, how it is built, its bugs. This holds even when the user is the one developing that software, and even though a user might ask about it: the software, its source and its documentation answer those questions, and a copy goes stale and then contradicts them.
- current status, readings, counts, or the state of work in progress.
- tasks, plans, reminders, and open problems.
- a history of what happened when.`;
