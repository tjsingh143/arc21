import { Alert } from "react-native";
import { router } from "expo-router";
import { useAuthStore } from "./auth-store";

/** Confirmation binds to the player being left, even if another auth task finishes. */
export async function confirmPlayerReplacement(action: string): Promise<{ userId: string | null } | null> {
  const account = useAuthStore.getState().session?.account;
  const expected = { userId: account?.userId ?? null };
  if (!account?.isAnonymous) return expected;
  return new Promise((resolve) => Alert.alert(
    "Leave this player?",
    "This player has no recovery email. Replacing this device’s session can make its chips, progress and friends inaccessible. Players are never merged. Secure this player first if you want to keep it.",
    [
      { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
      { text: "Secure this player", onPress: () => { resolve(null); router.push("/(auth)/create-account"); } },
      { text: action, style: "destructive", onPress: () => resolve(expected) },
    ],
    { cancelable: false },
  ));
}
