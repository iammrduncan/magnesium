import { Link } from "@tanstack/react-router";
import { memo } from "react";

import { Button } from "../ui/button";

/**
 * The picker's way to the Profiles page (goal 34): Edit profile for the
 * profile the thread runs, or Create a profile while there are none.
 */
export const ProfilePickerLinks = memo(function ProfilePickerLinks(props: {
  /** The profile the active instance runs, if any. */
  profile: string | null;
  hasProfiles: boolean;
  onNavigate: () => void;
}) {
  if (props.profile === null && props.hasProfiles) return null;
  return (
    <div className="flex justify-end border-t border-border p-1">
      {props.profile !== null ? (
        <Button
          size="xs"
          variant="ghost"
          render={
            <Link to="/profiles" search={{ name: props.profile }} onClick={props.onNavigate} />
          }
        >
          Edit profile
        </Button>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          render={<Link to="/profiles" onClick={props.onNavigate} />}
        >
          Create a profile
        </Button>
      )}
    </div>
  );
});
