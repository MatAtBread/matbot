import type { Session, FilterExpr, ISODate } from '@matatbread/matbot-plugin-api';

export interface MemoryEntry {
  id:                string;
  version:           string;
  kind:              'fact' | 'skill' | 'file';
  ownerPrincipalId:  string;
  sessionId:         string;
  messageId:         string;
  turnIndex:         number;
  span?:             { start: number; end: number };
  tags:              string[];
  embedding?:        number[];
  confidence:        number;
  decayRate:         number;
  recallCount:       number;
  contexts:          string[];
  createdAt:         ISODate;
  lastReinforcedAt:  ISODate;
}

export interface FileMemoryEntry extends MemoryEntry {
  kind:   'file';
  fileId: string;
}

export interface RecallQuery {
  text?:          string;
  embedding?:     number[];
  filter?:        FilterExpr;
  contexts?:      string[];
  limit?:         number;
  minConfidence?: number;
}

export interface ContextBlock {
  role:      'system';
  content:   string;
  sourceIds: string[];
}

export interface MemoryManager {
  recall(query: RecallQuery): Promise<MemoryEntry[]>;
  remember(entry: Omit<MemoryEntry, 'id' | 'version' | 'createdAt'>): Promise<MemoryEntry>;
  reinforce(id: string, delta?: number): Promise<void>;
  forget(id: string): Promise<void>;
  purge(ownerPrincipalId: string): Promise<number>;
  buildContext(session: Session, signal: AbortSignal): Promise<ContextBlock[]>;
}

declare module '@matatbread/matbot-plugin-api' {
  interface ServiceMap {
    '@matatbread/matbot-memory-types': MemoryManager;
  }
}
