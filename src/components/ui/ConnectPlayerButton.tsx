import { useAuthStore } from "../../features/auth/auth-store";
import { AppText } from "./AppText";
import { Button } from "./Button";

/** Retry server identity creation without asking for recovery credentials. */
export function ConnectPlayerButton({ testID }: { testID?: string }) {
  const ensurePlayer = useAuthStore((state) => state.ensurePlayer);
  const status = useAuthStore((state) => state.bootstrapStatus);
  const failure = useAuthStore((state) => state.bootstrapFailure);
  const configured = useAuthStore((state) => state.configured);
  return (
    <>
      <Button
        label={status === "connecting" ? "Connecting…" : "Connect for online play"}
        disabled={!configured || status === "connecting"}
        onPress={() => void ensurePlayer()}
        testID={testID}
        accessibilityHint="Creates or restores your player identity. No email or password needed."
      />
      {failure ? <AppText variant="caption" color="warning">{failure.message}</AppText> : null}
    </>
  );
}
