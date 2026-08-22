/**
 * The four-destination shell: HOME, PLAY, LEARN, SOCIAL.
 *
 * Four and only four. Profile opens from the avatar in each screen's header
 * rather than consuming a fifth tab — a tab bar that grows past four becomes a
 * menu, and the point of this one is that the whole product is reachable in a
 * glance.
 *
 * The table (`/game/practice`) lives outside this group precisely so it can go
 * full screen and hide the bar.
 */

import { Tabs } from "expo-router";

import { TabIcon, type TabIconName } from "../../src/components/ui/TabIcon";
import { colors } from "../../src/design/tokens";
import { typography } from "../../src/design/typography";

const TABS: Array<{ name: string; title: string; icon: TabIconName }> = [
  { name: "home", title: "Home", icon: "home" },
  { name: "play", title: "Play", icon: "play" },
  { name: "learn", title: "Learn", icon: "learn" },
  { name: "social", title: "Social", icon: "social" },
];

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          paddingTop: 6,
        },
        tabBarLabelStyle: {
          ...typography.caption,
          fontSize: 11,
          /*
           * An explicit line height, and no fixed bar height above.
           *
           * The bar used to hard-set `height: 64`, which overrides the height
           * React Navigation computes from the bottom safe-area inset — so on
           * a device with a home indicator the label was squeezed against the
           * bottom edge and the descender of "Play" was cut off, rendering as
           * "Plav". It clipped at every text size, not just large ones.
           * Default sizing already clears the 48dp minimum the removed comment
           * was worried about.
           */
          lineHeight: 14,
        },
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            // The label stays visible alongside the glyph: the shape reinforces
            // the destination, it never carries it alone.
            tabBarIcon: ({ focused }) => <TabIcon name={tab.icon} focused={focused} />,
            tabBarAccessibilityLabel: tab.title,
          }}
        />
      ))}
    </Tabs>
  );
}
