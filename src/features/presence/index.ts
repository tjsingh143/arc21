/**
 * Presence.
 *
 * Ephemeral by construction: it lives in a Realtime channel and is never
 * written to the database, so a crashed client cannot leave a stale "online"
 * behind for someone to believe an hour later.
 */

export {
  PRESENCE_TOPIC,
  describePresence,
  presenceEntrySchema,
  summarisePresence,
  type PresenceEntry,
  type PresenceState,
} from "./presence.js";

export { usePresenceStore, type PresenceStoreState } from "./presence-store.js";
