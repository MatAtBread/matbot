// ── Principal ───────────────────────────────────────────────────────────────

/** Identity of whatever initiated an operation — a turn, a tool call, a store read/write.
 *  Established at each entry point and carried ambiently via the `PrincipalCarrier`
 *  (`currentPrincipal()` / `runAs()`), so any layer can attribute or test the origin without it
 *  being threaded through every signature. It grants nothing — policy is the service's concern. */
export interface Principal {
  id:    string;
  type:  'user' | 'agent' | 'system';
}
