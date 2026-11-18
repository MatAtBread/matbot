import type { ISODate, Session } from '@matatbread/matbot-plugin-api';
import { lastActivityAt } from '@matatbread/matbot-plugin-api';

// Whether a session has been read is this plugin's: it is what `session_action` reports to a session list,
// and nothing else in matbot reads it. So the field is added here, by augmentation, and an install without
// this plugin carries none of it.
declare module '@matatbread/matbot-plugin-api' {
  interface Session {
    /** How far the session has been read: the `createdAt` of the last message a reader was shown, set by
     *  whoever showed it (`session_action get` with `markRead`). Absent ⇒ never tracked — every session
     *  until a reader is first shown it, which reads as read rather than marking every conversation at once.
     *  One per session, not per principal: a shared session read by one reader is read for all of them. */
    readAt?: ISODate;
  }
}

/** What a session list shows beside a session, most urgent first: a turn is waiting on a person
 *  (`prompting`), a turn is running or queued (`running`), or there is activity nobody has been shown
 *  (`unread`). Absent ⇒ none of these. */
export type SessionIndicator = 'prompting' | 'running' | 'unread';

/** Whether `session` has activity after the point it was last read to. A never-tracked session reads as read. */
export function isUnread(session: Session): boolean {
  return session.readAt !== undefined && lastActivityAt(session) > session.readAt;
}

/** The {@link SessionIndicator} for `session`, given the runner's live report on it (absent where no runner
 *  holds the session's turns — a background job's process). */
export function sessionIndicator(
  session: Session, live?: { busy: boolean; prompting: boolean },
): SessionIndicator | undefined {
  if (live?.prompting === true) return 'prompting';
  if (live?.busy      === true) return 'running';
  return isUnread(session) ? 'unread' : undefined;
}
