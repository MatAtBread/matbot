import type { Marker, Message } from '@matatbread/matbot-plugin-api';

export const MARKER_CREATOR = '@matatbread/matbot-edit-session';

// This plugin's marker payload, made type-safe by augmenting the shared MarkerData registry.
// Any reader narrowing on creator === MARKER_CREATOR gets the typed `data` for free.
declare module '@matatbread/matbot-plugin-api' {
  interface MarkerData {
    '@matatbread/matbot-edit-session':
      // A cross-thread link, written by fork/split.
      | {
          /** 'split-from': earlier messages were split into peerSessionId (navigate back).
           *  'continued-in': this conversation continued in peerSessionId (navigate forward).
           *  'forked-from': this session was forked from peerSessionId (navigate to the origin). */
          relation:      'split-from' | 'continued-in' | 'forked-from';
          peerSessionId: string;
          /** Message index in peerSessionId to scroll to. Baked at edit time, so it's fragile to later
           *  inserts/removes in the peer — best-effort; the UI scrolls there only if it still resolves. */
          targetMsg:     number;
        }
      // The history a `summarise` replaced, written in its place.
      | {
          relation:     'summarised';
          /** The replaced messages, verbatim. A marker is elided from every submission, so they cost the
           *  model nothing while remaining readable — which is what lets a LATER summarise re-read the
           *  original history instead of summarising a summary. Held flat: a summarise expands any marker
           *  it finds in the range it is replacing, so there is never a chain to walk. */
          messages:     Message[];
          summarisedAt: string;
        };
  }
}

export type EditSessionMarkerData = Marker<typeof MARKER_CREATOR>['data'];

export function now(): string { return new Date().toISOString(); }

// A standalone marker message: opaque to the LLM (the 'marker' role is skipped by every provider
// converter), preserved by compaction, carried with the session for the UI to render as a
// cross-thread link.
//
// `createdAt` is settable because a marker does not always record something that happened NOW: one
// replacing earlier history belongs where that history was, and `lastActivityAt` reads the last
// message's stamp, so a now-stamped marker at the FRONT of a session would be harmless while the same
// marker replacing a whole session would jump it to the top of a recency-sorted list.
export function markerMessage(data: EditSessionMarkerData, createdAt = now()): Message {
  const marker: Marker<typeof MARKER_CREATOR> = { type: 'marker', creator: MARKER_CREATOR, data };
  return {
    id:        crypto.randomUUID(),
    role:      'marker',
    content:   [marker],
    createdAt,
    traceId:   crypto.randomUUID(),
  };
}
