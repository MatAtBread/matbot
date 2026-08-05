// ── Health ────────────────────────────────────────────────────────────────────

export type HealthStatus =
  | { status: 'ok';       latencyMs?: number }
  | { status: 'degraded'; reason: string; latencyMs?: number }
  | { status: 'down';     reason: string };
