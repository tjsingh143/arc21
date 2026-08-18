/**
 * The account group.
 *
 * Two screens, no tab bar, and the Supabase foreground refresh loop started
 * here — this is the first place in the app that cares whether a token is
 * current, and `startSupabaseAutoRefresh` is a no-op when the build has no
 * server configured.
 */

import { useEffect } from "react";
import { Stack } from "expo-router";

import { colors } from "../../src/design/tokens";
import {
  startSupabaseAutoRefresh,
  stopSupabaseAutoRefresh,
} from "../../src/lib/supabase/auto-refresh";

export default function AuthLayout() {
  useEffect(() => {
    startSupabaseAutoRefresh();
    return stopSupabaseAutoRefresh;
  }, []);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        animation: "fade",
      }}
    />
  );
}
