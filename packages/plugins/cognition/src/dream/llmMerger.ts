/**
 * LLM-backed implementation of {@link Merger}.
 *
 * One `singleTurn` call per fact-to-merge. The model is shown the full current skill markdown and
 * the fact, and is asked to return the COMPLETE updated markdown plus a structured list of any
 * `(!) Note:` contradiction markers it inserted. The pipeline calls this once per fact in the
 * cluster (primary plus mates), threading each call's output as the next call's input — so a
 * contradiction added in fact N is visible when fact N+1 is considered.
 *
 * Prose editing is the one step in dream-time that genuinely needs an LLM. No near-term
 * non-LLM implementation is on the horizon; the {@link Merger} interface exists for symmetry and
 * test-doubling, not because a swap is planned.
 *
 * On parse failure or model error this implementation THROWS. That choice differs from the ranker
 * (which degrades to zero scores) because a failed merge means the cluster CAN'T proceed — the
 * pipeline catches the throw and records the run as `error` with no skill writes. A silent
 * fall-through here would risk a partial cluster being committed, which is exactly the kind of
 * inconsistency the deterministic spine is meant to prevent.
 */

import type { MatbotServices } from '@matatbread/matbot-plugin-api';
import type { Merger } from './ranker.js';
import type { MergeResult, RememberedFact } from './types.js';

const MERGER_SYSTEM = `
You are the merge stage of a memory-consolidation pass. You are given the FULL markdown of an existing skill and ONE remembered fact. Splice the fact into the skill while preserving everything else.

Return ONLY a JSON object on the last line of your reply, in this shape: 
{ 
  "content": "", 
  "contradictions": [ { "location": "", "note": "" } ], 
  "anomalies": [ { "fact": "", "reasoning": "<why it doesn't fit the skill's structure>" } ] 
}

Rules:

* PRESERVE all existing content. Never delete or overwrite material. The output's length must be >= the input's.

* FIRST, decide where the fact belongs: 
  1. GOOD FIT — the fact is about the skill's domain and fits under an existing heading. Add it as a new subsection under that heading. Add a new heading if needed, in a natural place — do not just append to the bottom unless that genuinely fits the skill's structure. 
  2. POOR FIT — the fact could relate broadly to the skill's topic area but it's focus is on a different aspect, or its subject matter is a different kind of information than the surrounding content (e.g. a transient observation mixed with durable procedures, or an operational note in an artchiectural discussion, or a general fact in a personal profile, or the reverse of either). Place it in an "## Anomalies" section at the very end of the skill. If "## Anomalies" doesn't exist yet, create it. Add the fact as a bullet point under it. Insert an inline marker in this EXACT format immediately before the fact: (?) Tangential: "" AND list the anomaly in the JSON "anomalies" array with the fact summary and reasoning. 

* Keep the existing heading style, prose voice, and formatting conventions.

* If the new fact is a duplicate or near-duplicate of an existing fact, do not add it again. Instead, update the existing content to reflect the new fact's information.

* If the new fact CONTRADICTS existing content, insert an inline marker at the contradiction site using this EXACT format (the literal "(!) Note:" prefix matters; a later tool scans for it):

  (!) Note: The new fact says "<short summary of new>", but existing content says
  "<short summary of existing>". May need human review to reconcile.

AND list the contradiction in the JSON "contradictions" array. Do not block the merge on a contradiction — record it inline and continue. If there are no contradictions, return an empty array.
* A fact can be BOTH tangential AND contradictory. In that case, use the "(!) Note:" marker for the contradiction and "## Anomalies" for the placement. List entries in both arrays.

* "location" in the JSON contradictions is a short hint (e.g. the heading you placed the marker under). Precision is not required; it is for a human reading a run report.

* If there are no anomalies, return an empty "anomalies" array.

COHERENCE if resulting skill content has made pre-existing facts anomalous, you may move them to the "## Anomalies" section, but do not delete them. If you do this, add a note in the JSON "anomalies" array with the fact summary and reasoning.

Do not include any prose outside the JSON object. Do not wrap it in code fences. The "content" string must be the entire skill markdown, not a diff or a fragment.`;

function extractJsonObject(text: string): string | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : undefined;
}

function parseMergeResult(raw: string): MergeResult | undefined {
  const block = extractJsonObject(raw);
  if (block === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(block); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as { content?: unknown; contradictions?: unknown };
  if (typeof obj.content !== 'string')         return undefined;
  if (!Array.isArray(obj.contradictions))      return undefined;

  const contradictions: MergeResult['contradictions'] = [];
  for (const row of obj.contradictions) {
    if (typeof row !== 'object' || row === null) return undefined;
    const r = row as { location?: unknown; note?: unknown };
    if (typeof r.location !== 'string' || typeof r.note !== 'string') return undefined;
    contradictions.push({ location: r.location, note: r.note });
  }
  return { content: obj.content, contradictions };
}

/** Construct an LLM-backed merger bound to a configured provider name. */
export function createLlmMerger(services: MatbotServices, provider: string): Merger {
  return {
    async merge(
      skillName:    string,
      skillContent: string,
      fact:         RememberedFact,
      signal:       AbortSignal,
    ): Promise<MergeResult> {
      const prompt =
        `Skill: ${skillName}\n` +
        `---begin current skill markdown---\n${skillContent}\n---end current skill markdown---\n\n` +
        `Fact to merge (id ${fact.id}, from session ${fact.sessionId}, recorded ${fact.createdAt}):\n` +
        `${fact.fact}\n\n` +
        `Return the complete updated markdown.`;

      const res = await services.singleTurn({
        provider, signal, system: MERGER_SYSTEM, prompt,
      });

      const parsed = parseMergeResult(res.text);
      if (parsed === undefined) {
        throw new Error(
          `dream-time merger returned an unparseable response for fact ${fact.id}; ` +
          `first 200 chars: ${res.text.slice(0, 200)}`,
        );
      }

      // Defensive structural check: the prompt told the model never to shrink the content. If it
      // did anyway, refuse the merge rather than silently overwriting good material with a
      // truncated version. The pipeline catches this and records the run as `error`.
      if (parsed.content.length < skillContent.length) {
        throw new Error(
          `dream-time merger returned shorter content (${parsed.content.length} chars) than the ` +
          `input (${skillContent.length} chars) for fact ${fact.id}; refusing to overwrite`,
        );
      }

      return parsed;
    },
  };
}
