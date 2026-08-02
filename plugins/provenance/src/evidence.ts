import type { Message, Session } from '@matatbread/matbot-plugin-api';

/** One indivisible piece of the session, tagged with where it came from (`USER`, `TOOL:<name>`). */
export interface Unit { from: string; text: string }

/** Spellings of one search key. A group is satisfied when any spelling is present, so a formatting
 *  difference (4,200,000 vs 4200000) never reads as an absence. */
export type KeyGroup = string[];

const BULLET = /^\s*([-*+•]|\d+[.)])\s/;
const STOP = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were', 'of', 'in', 'at', 'on', 'for', 'and', 'or', 'to',
  'his', 'her', 'their', 'its', 'it', 'this', 'that', 'user', 'has', 'have', 'had',
]);

// Splitting, rather than truncating, is the whole game. One tool result can be 200KB and the support
// for a claim can sit anywhere in it, so any positional cap — at any layer — reads as "no evidence
// exists" for the commonest case there is. Rows carry their header because a row of bare numbers
// cannot be read; bullets split because a markdown list is `items[]` written in prose.
function pushText(units: Unit[], from: string, text: string): void {
  for (const para of text.split(/\n\s*\n/)) {
    const lines = para.split('\n').filter(l => l.trim().length > 0);
    const delimited = lines.filter(l => /[,|\t]/.test(l)).length;
    if (lines.length > 3 && delimited >= lines.length - 1) {
      const header = lines[0] ?? '';
      for (let i = 1; i < lines.length; i++) push(units, from, `${header}\n${lines[i]}`);
      continue;
    }
    if (lines.length > 2 && lines.filter(l => BULLET.test(l)).length >= lines.length - 1) {
      let item = '';
      for (const line of lines) {
        if (BULLET.test(line) && item) { push(units, from, item); item = line; }
        else item = item ? `${item}\n${line}` : line;
      }
      if (item) push(units, from, item);
      continue;
    }
    push(units, from, para);
  }
}

function push(units: Unit[], from: string, text: string): void {
  const t = text.trim();
  if (t.length > 0) units.push({ from, text: t });
}

function explode(units: Unit[], from: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') { pushText(units, from, value); return; }
  if (Array.isArray(value)) { for (const v of value) explode(units, from, v); return; }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj['items'])) { for (const item of obj['items']) explode(units, from, item); return; }
    if (typeof obj['content'] === 'string') { pushText(units, from, obj['content']); return; }
    // A big string in a property (a CSV under `rows`, a report under `text`) is a document, not a
    // field. Small objects stay whole: splitting `{fact, sessionId}` would separate a fact from the
    // provenance that makes it citable.
    const big = Object.keys(obj).filter(k => typeof obj[k] === 'string' && (obj[k] as string).length > 400);
    if (big.length === 0) { push(units, from, JSON.stringify(obj)); return; }
    const rest: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) if (!big.includes(k)) rest[k] = obj[k];
    for (const k of big) pushText(units, from, obj[k] as string);
    if (Object.keys(rest).length > 0) push(units, from, JSON.stringify(rest));
    return;
  }
  push(units, from, String(value));
}

function messageText(m: Message): string {
  return m.content
    .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
    .map(c => c.text)
    .join('\n')
    .trim();
}

/** Everything the session can account for: what the user said, and what every tool returned. */
export function buildUnits(session: Session): Unit[] {
  const names = new Map<string, string>();
  for (const m of session.messages) {
    for (const c of m.content) if (c.type === 'tool-call') names.set(c.id, c.name);
  }
  const units: Unit[] = [];
  for (const m of session.messages) {
    if (m.role === 'user')   { push(units, 'USER', messageText(m)); continue; }
    if (m.role === 'marker') continue;
    for (const c of m.content) {
      if (c.type === 'tool-result') explode(units, `TOOL:${names.get(c.id) ?? 'unknown'}`, c.result);
    }
  }
  return units;
}

/** Proper nouns and numbers — the high-selectivity tokens a claim can be looked up by. */
export function deriveKeys(claim: string): KeyGroup[] {
  const groups: KeyGroup[] = [];
  // \x22/\x27 rather than literal quotes: a quote inside a regex literal opens a string for the
  // function-tools signature scanner, and this file is the reference implementation for both.
  for (const match of claim.match(/\x22[^\x22]+\x22|[A-Z][A-Za-z\x27-]{1,}|\d[\d,.]*\s*(?:%|k|K|m|M|bn|BN)?/g) ?? []) {
    const key = match.replace(/^\x22|\x22$/g, '').trim();
    if (key.length < 2 || STOP.has(key.toLowerCase())) continue;
    const bare = key.replace(/,/g, '');
    groups.push(bare !== key ? [key, bare] : [key]);
  }
  return groups.slice(0, 8);
}

export function wordRe(key: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
}

export function isNumericKey(group: KeyGroup): boolean {
  return /\d/.test(group[0] ?? '');
}

/**
 * Units bearing on a claim, best first. `strict` (the caller named its keys, so it has said what
 * discriminates) makes an absent key decisive: "Dermot is Matt's brother-in-law" must not select five
 * extracts on the strength of "Matt's" alone, none of which mention Dermot — material that reads as
 * corroboration for a name appearing nowhere. Zero is the correct answer there.
 *
 * Without caller keys the veto applies only to numbers, where absence is unambiguous: a derived
 * capitalised word may just be the answer's own phrasing ("Revenue" where the data says "sales"), and
 * vetoing on vocabulary would report sourced claims as confabulated.
 */
export function selectEvidence(pool: Unit[], groups: KeyGroup[], claim: string, strict: boolean, maxUnits = 40): Unit[] {
  if (groups.length === 0) return [];
  const res = groups.map(g => g.map(wordRe));
  const hits = (g: RegExp[], lower: string): boolean => g.some(r => r.test(lower));

  for (let i = 0; i < groups.length; i++) {
    const group = res[i];
    if (group === undefined) continue;
    if (pool.some(u => hits(group, u.text.toLowerCase()))) continue;
    if (strict || isNumericKey(groups[i] ?? [])) return [];
  }

  const claimWords = claim.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !STOP.has(w));
  const scored: Array<{ score: number; at: number; unit: Unit }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < pool.length; i++) {
    const unit = pool[i];
    if (unit === undefined) continue;
    const lower = unit.text.toLowerCase();
    const keyHits = res.filter(g => hits(g, lower)).length;
    if (keyHits === 0) continue;
    const dedupe = unit.text.slice(0, 200);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    scored.push({ score: keyHits * 10 + claimWords.filter(w => lower.includes(w)).length, at: i, unit });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.at - b.at));
  // A relevance floor, not a cap: with keys ["Tom","SALT"] a unit matching one is "Tom Jones: rated
  // green" and one matching both is the son. Once something scores well, stop spending prompt budget
  // on units that matched a single common token.
  const best = scored[0]?.score ?? 0;
  const floor = best >= 20 ? best / 2 : 0;
  return scored.filter(s => s.score >= floor).slice(0, maxUnits).map(s => s.unit);
}

/** Excerpt an over-long unit AROUND its match, never from its head. Head-anchored truncation is how
 *  evidence goes missing: support at char 1093 of a 2308-char unit, shown as a 600-char head, is a
 *  passage that genuinely does not mention the claim. */
export function excerpt(text: string, res: RegExp[][], room: number): string {
  if (text.length <= room) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const group of res) {
    for (const r of group) {
      const m = lower.search(r);
      if (m >= 0 && (at < 0 || m < at)) at = m;
    }
  }
  if (at < 0) return text.slice(0, room);
  const start = Math.max(0, at - Math.floor(room / 3));
  const end   = Math.min(text.length, start + room);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

/** Numbered extracts within one budget, spent best-first — the only cap in the system, and it belongs
 *  here because the constraint is the classifier's context window, not anything about the search. */
export function renderExtracts(sel: Unit[], res: RegExp[][], budget: number): string {
  const out: string[] = [];
  let left = budget;
  for (let i = 0; i < sel.length; i++) {
    const unit = sel[i];
    if (unit === undefined || left <= 200) break;
    const text = excerpt(unit.text, res, left);
    out.push(`(${i}) [${unit.from}] ${text}`);
    left -= text.length;
  }
  return out.join('\n');
}
