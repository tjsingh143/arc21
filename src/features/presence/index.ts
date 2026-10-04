/**
 * Presence.
 *
 * A server heartbeat projection scoped to friends and block rules. The client
 * never publishes a user ID or presence state for another player.
 */

export {
  PRESENCE_TOPIC,
  describePresence,
  presenceFromRows,
  presenceEntrySchema,
  summarisePresence,
  type PresenceEntry,
  type PresenceState,
} from "./presence.js";

export { usePresenceStore, type PresenceStoreState } from "./presence-store.js";
