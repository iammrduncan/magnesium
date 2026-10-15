import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";
import { memo } from "react";

import { cn } from "~/lib/utils";

/**
 * A Magnesium profile's avatar: its initials on its accent colour (the Session
 * board's "SE" for `serving`). Shown in place of the driver icon wherever the
 * picker shows a profile's instance.
 */
export const ProfileAvatar = memo(function ProfileAvatar(props: {
  name: string;
  accentColor?: string | undefined;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-profile-avatar
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-xs font-semibold text-4xs leading-none",
        props.accentColor ? "text-white" : "bg-muted text-muted-foreground",
        props.className,
      )}
      style={props.accentColor ? { backgroundColor: props.accentColor } : undefined}
    >
      {providerInstanceInitials(props.name)}
    </span>
  );
});
