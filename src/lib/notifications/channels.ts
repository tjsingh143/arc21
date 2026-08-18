/**
 * Android notification channel ids.
 *
 * In their own file because both halves of the system name them and the two must
 * agree: the server puts a `channelId` on every push message
 * (`supabase/functions/_shared/push-message.ts`), and the device creates the
 * channels with those ids. A message naming a channel that does not exist lands
 * on Android's fallback, quietly losing the importance the kind was given.
 *
 * There is a test asserting the two lists match, because a constant duplicated
 * across a runtime boundary is a constant that eventually disagrees with itself.
 */

export const ANDROID_CHANNEL_TURN = "arc21-turn";
export const ANDROID_CHANNEL_DEFAULT = "arc21-default";
