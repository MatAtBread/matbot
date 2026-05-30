export interface SkillDoc {
  id:           string;
  version:      string;
  name:         string;
  content:      string;
  contexts:     string[];
  tags?:        string[];
  toolBinding?: string;
  createdAt:    string;
  updatedAt:    string;
}
