/**
 * Root layout.
 *
 * The crypto polyfill is installed before anything else imports the engine: the
 * shared `CryptoRandomSource` refuses to construct without Web Crypto rather
 * than falling back to `Math.random()`, so this must run first.
 *
 * Routes are auto-discovered from the filesystem rather than declared here, so
 * adding a screen never requires editing this file.
 *
 * Two device adapters are installed here and only here: the audio sink, and the
 * notification handler. Both are wired at the root because both must exist
 * before any screen that uses them mounts, and neither may be installed twice.
 *
 * THE SESSION IS RESTORED HERE for the same reason. It used to be hydrated only
 * by the five screens that happened to ask — sign-in, create-account, recovery,
 * Social and Profile — so a cold launch straight to Home left `mode` at
 * "unknown" and the header told a signed-in player they were a GUEST, while
 * Settings said "Signed in" the moment you reached it through Profile. Found in
 * phase 14 s4 by signing in on the simulator, relaunching, and comparing the
 * two screens. `hydrate()` early-returns once hydrated, so the per-screen calls
 * are now harmless no-ops rather than the only thing keeping this working.
 */

import { installCryptoPolyfill } from "../src/lib/crypto/install-crypto-polyfill";

installCryptoPolyfill();

import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AccessibilityPrefsProvider } from "../src/design/accessibility";
import { useAuthStore } from "../src/features/auth/auth-store";
import { colors } from "../src/design/tokens";
import { OfflineBanner } from "../src/components/ui/OfflineBanner";
import { TABLE_SCREEN_OPTIONS } from "../src/features/table/leave-guard";
import { preloadTableSounds, setAudioSink } from "../src/lib/audio/audio";
import { ExpoAudioSink, configureAudioSession } from "../src/lib/audio/expo-audio-sink";
import { installLiveAnnouncementSink } from "../src/lib/accessibility/announce";
import { configureNotificationHandler, ensureAndroidChannels } from "../src/lib/notifications/push";
import { useNotificationRouting } from "../src/lib/notifications/use-notification-routing";
import { useProfilePrivacySync } from "../src/features/settings/use-profile-privacy-sync";

export default function RootLayout() {
  useNotificationRouting();
  useProfilePrivacySync();

  const hydrateAuth = useAuthStore((state) => state.hydrate);
  useEffect(() => {
    void hydrateAuth();
  }, [hydrateAuth]);

  useEffect(() => {
    const sink = new ExpoAudioSink();
    setAudioSink(sink);
    void configureAudioSession();
    // Decoding the common cues now means the first card of a session does not
    // stutter while a file is read.
    void preloadTableSounds();

    installLiveAnnouncementSink();

    configureNotificationHandler();
    void ensureAndroidChannels();

    return () => {
      sink.release();
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <SafeAreaProvider>
        <AccessibilityPrefsProvider>
          <StatusBar style="light" />
          {/*
            Above the navigator, so it is said once rather than five times.
            Renders nothing unless the server has actually failed to answer —
            see the component, and note it asks no radio-state library, because
            "there is a network interface" is not the question a player has.
          */}
          <OfflineBanner />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
              animation: "fade",
            }}
          >
            {/*
              THE TABLE CANNOT BE SWIPED AWAY FROM.

              Leaving a table is an economic command — `CASH_OUT` returns the
              remaining stack to the wallet — and `app/table/[gameId].tsx` sends
              it from its "Leave table" control, refusing to navigate if the
              server says no. The iOS swipe-back gesture is enabled by default
              on a native stack and does not go through that control, so a swipe
              popped the screen with the buy-in still in escrow: the seat stayed
              `active`, the wallet stayed short, and the screen that took the
              chips had promised "whatever is left comes back when you leave".

              Turning the gesture off is half the fix. The screen also holds a
              `beforeRemove` listener, because a gesture is not the only way a
              route can be removed — the Android hardware back button and a deep
              link that replaces the stack both do it without touching this
              option.
            */}
            <Stack.Screen name="table/[gameId]" options={TABLE_SCREEN_OPTIONS} />
          </Stack>
        </AccessibilityPrefsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
