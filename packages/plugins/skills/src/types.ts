export type TriggerPhase = 'agent' | 'user' | 'system';

/**
 * A single trigger embedded in a skill. `id` is the stable identity (a UUID minted on write if
 * absent and preserved across updates) — never the text, never the array position — so a client
 * can address one trigger reliably across separate operations (telegram edit, HTTP form POST).
 */
export interface SkillTrigger {
  id?:     string;
  phase:   TriggerPhase;
  trigger: string;
}

export interface SkillDoc {
  id:           string;
  version:      string;
  name:         string;
  content:      string;
  triggers?:    SkillTrigger[];
  tags?:        string[];
  toolBinding?: string;
  createdAt:    string;
  updatedAt:    string;
}
