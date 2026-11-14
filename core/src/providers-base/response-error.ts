import { failureForStatus, withFailure, type FailureClass } from '@matatbread/matbot-plugin-api';

// The error for an endpoint's non-ok answer: its status and body in the message, as every adapter wrote it,
// and the class the status implies, so a caller can tell an overloaded endpoint (try later) from a rejected
// key or a malformed request (trying again changes nothing) without parsing the message for a number.
export async function responseError(label: string, res: Response): Promise<Error & { failure?: FailureClass }> {
  const text = await res.text().catch(() => res.statusText);
  return withFailure(new Error(`${label} ${res.status}: ${text}`), failureForStatus(res.status));
}
