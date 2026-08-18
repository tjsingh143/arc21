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
 */

import { installCryptoPolyfill } from "../src/lib/crypto/install-crypto-polyfill";

installCryptoPolyfill();

import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { colors } from "../src/design/tokens";
import { preloadTableSounds, setAudioSink } from "../src/lib/audio/audio";
import { ExpoAudioSink, configureAudioSession } from "../src/lib/audio/expo-audio-sink";
import { configureNotificationHandler, ensureAndroidChannels } from "../src/lib/notifications/push";
import { useNotificationRouting } from "../src/lib/notifications/use-notification-routing";

export default function RootLayout() {
  useNotificationRouting();

  useEffect(() => {
    const sink = new ExpoAudioSink();
    setAudioSink(sink);
    void configureAudioSession();
    // Decoding the common cues now means the first card of a session does not
    // stutter while a file is read.
    void preloadTableSounds();

    configureNotificationHandler();
    void ensureAndroidChannels();

    return () => {
      sink.release();
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
            animation: "fade",
          }}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
