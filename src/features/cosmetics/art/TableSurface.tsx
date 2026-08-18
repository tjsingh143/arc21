/**
 * The equipped table theme, as a background layer.
 *
 * Renders behind a table screen's content: the theme's flat surface plus its
 * one permitted element. It subscribes to the loadout store itself so every
 * table — practice, career, private, public, tournament, daily — gets the
 * change the moment a theme is equipped, and it asks the store to load on
 * mount so a table opened cold shows the equipped theme rather than the
 * default until the next visit.
 *
 * It never intercepts a touch and it renders synchronously from store state:
 * a guest's practice table is drawing the default theme before any network
 * request has a chance to answer.
 */

import { memo, useEffect, useMemo } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";

import { tableThemeArt } from "./registry.js";
import { useLoadoutStore } from "../loadout-store.js";

export const TableSurface = memo(function TableSurface() {
  const tableThemeKey = useLoadoutStore((state) => state.loadout.tableThemeKey);
  const load = useLoadoutStore((state) => state.load);
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Derived with `useMemo` from subscribed state rather than by calling a store
   * getter during render — that freezes the value under the React Compiler.
   */
  const theme = useMemo(() => tableThemeArt(tableThemeKey), [tableThemeKey]);

  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.surface }]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {theme.Element ? <theme.Element width={width} height={height} /> : null}
    </View>
  );
});
