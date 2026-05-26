import type { MemoryEntry } from '@matbot/plugin-api';

export interface SkillEntry extends MemoryEntry {
  kind:         'skill';
  name:         string;
  contentRef:
    | { kind: 'file';    path: string }
    | { kind: 'message'; sessionId: string; messageId: string };
  toolBinding?: string;
}

export function makeSkillEntry(filePath: string, name: string): SkillEntry {
  const now = new Date().toISOString();
  return {
    id:               crypto.randomUUID(),
    version:          crypto.randomUUID(),
    kind:             'skill',
    ownerPrincipalId: 'system',
    sessionId:        '',
    messageId:        '',
    turnIndex:        0,
    tags:             ['skill'],
    confidence:       1.0,
    decayRate:        0,
    recallCount:      0,
    contexts:         ['global'],
    name,
    contentRef:       { kind: 'file', path: filePath },
    createdAt:        now,
    lastReinforcedAt: now,
  };
}
