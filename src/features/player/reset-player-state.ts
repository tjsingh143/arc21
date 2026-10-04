import { useCareerServerStore } from "../career/career-server-store.js";
import { useCosmeticsStore } from "../cosmetics/cosmetics-store.js";
import { useLoadoutStore } from "../cosmetics/loadout-store.js";
import { useDailyStore } from "../daily/daily-store.js";
import { useFriendsStore } from "../friends/friends-store.js";
import { useLeaderboardStore } from "../leaderboards/leaderboards-store.js";
import { useMatchmakingStore } from "../matchmaking/matchmaking-store.js";
import { useNotificationsStore } from "../notifications/notifications-store.js";
import { usePresenceStore } from "../presence/presence-store.js";
import { useRoomsStore } from "../rooms/rooms-store.js";
import { useCompetitionStore } from "../stats/competition-store.js";
import { useLevelStore } from "../stats/level-store.js";
import { useActiveSessionStore } from "../table/active-session-store.js";
import { useOnlineTableStore } from "../table/online-table-store.js";
import { useTournamentStore } from "../tournament/tournament-store.js";
import { useWalletStore } from "../wallet/wallet-store.js";
import { useQuickPlayStore } from "../quick-play/quick-play-store.js";
import { invalidatePlayerScope } from "./player-scope.js";

/** Server state belongs to a user ID. Device Practice and preferences stay local. */
export function resetPlayerState(): void {
  invalidatePlayerScope();
  useQuickPlayStore.setState({ opening: false, notice: null });
  usePresenceStore.getState().leave();
  useOnlineTableStore.getState().forgetTable();
  useWalletStore.setState(useWalletStore.getInitialState(), true);
  useActiveSessionStore.setState(useActiveSessionStore.getInitialState(), true);
  useFriendsStore.setState(useFriendsStore.getInitialState(), true);
  useRoomsStore.setState(useRoomsStore.getInitialState(), true);
  useMatchmakingStore.setState(useMatchmakingStore.getInitialState(), true);
  useDailyStore.setState(useDailyStore.getInitialState(), true);
  useTournamentStore.setState(useTournamentStore.getInitialState(), true);
  useCareerServerStore.setState(useCareerServerStore.getInitialState(), true);
  useCompetitionStore.setState(useCompetitionStore.getInitialState(), true);
  useLevelStore.setState(useLevelStore.getInitialState(), true);
  useCosmeticsStore.setState(useCosmeticsStore.getInitialState(), true);
  useLoadoutStore.setState(useLoadoutStore.getInitialState(), true);
  useLeaderboardStore.setState(useLeaderboardStore.getInitialState(), true);
  useNotificationsStore.setState(useNotificationsStore.getInitialState(), true);
}
