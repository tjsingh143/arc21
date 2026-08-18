/**
 * Inventory.
 *
 * Tabs for Avatar / Cards / Table, a grid of owned and locked items, what each
 * locked one needs, and equip. What is deliberately absent: a price, a currency,
 * a crate, and a Shop route. Nothing here can be bought, so nothing here shows a
 * cost — the specification is explicit that the MVP shows no purchase price.
 *
 * Cosmetics change nothing about play. The engine, the rules, the shoe and the
 * settlement never read one.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, spacing } from "../../src/design/tokens";
import {
  KIND_TABS,
  canEquip,
  itemsOfKind,
  lockedLabel,
  summarise,
  useCosmeticsStore,
  type CosmeticKind,
} from "../../src/features/cosmetics";

export default function Inventory() {
  const status = useCosmeticsStore((state) => state.status);
  const notice = useCosmeticsStore((state) => state.notice);
  const busy = useCosmeticsStore((state) => state.busy);
  const newlyGranted = useCosmeticsStore((state) => state.newlyGranted);
  const load = useCosmeticsStore((state) => state.load);
  const equip = useCosmeticsStore((state) => state.equip);

  const [tab, setTab] = useState<CosmeticKind>("avatar");

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Derived with `useMemo` from subscribed state rather than by calling a store
   * getter during render — that freezes the value under the React Compiler.
   */
  const items = useMemo(
    () => (status.kind === "ready" ? status.items : []),
    [status],
  );
  const shown = useMemo(() => itemsOfKind(items, tab), [items, tab]);
  const counts = useMemo(() => summarise(items, tab), [items, tab]);

  const onEquip = useCallback((id: string) => void equip(id), [equip]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.bar}>
        <BackBar />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <AppText variant="pageTitle" accessibilityRole="header">
            Inventory
          </AppText>
          <AppText variant="body" color="textSecondary">
            Everything here is earned by playing, and none of it changes the game.
          </AppText>
        </View>

        {status.kind === "loading" ? (
          <AppText variant="body" color="textSecondary">
            Reading your inventory…
          </AppText>
        ) : status.kind === "unavailable" ? (
          <UnavailableNote>{status.message}</UnavailableNote>
        ) : (
          <>
            {newlyGranted > 0 ? (
              <SurfaceCard>
                <AppText variant="bodyStrong" testID="inventory-newly-granted">
                  {newlyGranted === 1
                    ? "One new item unlocked."
                    : `${newlyGranted} new items unlocked.`}
                </AppText>
              </SurfaceCard>
            ) : null}

            <View style={styles.tabs}>
              {KIND_TABS.map((option) => (
                <SurfaceCard
                  key={option.kind}
                  onPress={() => setTab(option.kind)}
                  testID={`inventory-tab-${option.kind}`}
                  accessibilityLabel={option.label}
                  selected={option.kind === tab}
                  style={[styles.tab, option.kind === tab ? styles.tabActive : null]}
                >
                  <AppText
                    variant="caption"
                    color={option.kind === tab ? "textPrimary" : "textSecondary"}
                    align="center"
                  >
                    {option.label}
                  </AppText>
                </SurfaceCard>
              ))}
            </View>

            <AppText variant="caption" color="textDisabled" numeric testID="inventory-count">
              {`${counts.owned} of ${counts.total} unlocked`}
            </AppText>

            {notice ? (
              <AppText variant="body" color="warning" testID="inventory-notice">
                {notice}
              </AppText>
            ) : null}

            <View style={styles.grid}>
              {shown.map((item) => (
                <SurfaceCard
                  key={item.cosmetic_id}
                  style={item.equipped ? styles.equipped : null}
                  accessibilityLabel={item.name}
                >
                  <View style={styles.itemHeader}>
                    <AppText variant="bodyStrong" color={item.owned ? "textPrimary" : "textSecondary"}>
                      {item.name}
                    </AppText>
                    {item.equipped ? (
                      <AppText variant="caption" color="success">
                        Equipped
                      </AppText>
                    ) : null}
                  </View>

                  {item.description ? (
                    <AppText variant="caption" color="textSecondary">
                      {item.description}
                    </AppText>
                  ) : null}

                  {item.owned ? (
                    canEquip(item) ? (
                      <Button
                        label="Equip"
                        variant="secondary"
                        testID={`inventory-equip-${item.code}`}
                        accessibilityHint={`Equips ${item.name}`}
                        disabled={busy}
                        onPress={() => onEquip(item.cosmetic_id)}
                      />
                    ) : null
                  ) : (
                    /* What to DO, in the server's own words — never a price. */
                    <AppText variant="caption" color="warning" testID={`inventory-locked-${item.code}`}>
                      {lockedLabel(item)}
                    </AppText>
                  )}
                </SurfaceCard>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  bar: { paddingHorizontal: layout.screenPadding },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  header: { gap: spacing.xs },
  tabs: { flexDirection: "row", gap: spacing.xs },
  tab: { flex: 1, paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
  tabActive: { borderColor: colors.accent },
  grid: { gap: spacing.md },
  itemHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
  equipped: { borderColor: colors.accent },
});
