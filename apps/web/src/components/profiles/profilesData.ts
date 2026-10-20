// magnesium: the Profiles page's data from the hub (goal 34)
import type {
  DeletedProfile,
  ProfileDetail,
  ProfileList,
  ProfileSaveResult,
} from "@magnesium/contracts";
import { deletedProfiles, listProfilesOnHub, profileDetail } from "@magnesium/web";
import { useCallback, useEffect, useState } from "react";

import { toastManager } from "../ui/toast";

const pageUrl = () => window.location.href;

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : "The hub did not take that.";

const listeners = new Set<() => void>();

/** Tells every open profile list to read again: the page, the sidebar's bots, the palette. */
export const profilesChanged = () => {
  for (const listener of listeners) listener();
};

/** The profiles on the hub, and the deleted ones that can still come back. */
export function useProfileList() {
  const [list, setList] = useState<ProfileList | null>(null);
  const [deleted, setDeleted] = useState<ReadonlyArray<DeletedProfile>>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [next, gone] = await Promise.all([
        listProfilesOnHub(pageUrl()),
        deletedProfiles(pageUrl()),
      ]);
      setList(next);
      setDeleted(gone);
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const listener = () => void refresh();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [refresh]);
  return { list, deleted, error, refresh };
}

/** One profile, whole, read again after every change. */
export function useProfileDetail(name: string | null) {
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (name === null) return;
    try {
      setDetail(await profileDetail(pageUrl(), name));
      setError(null);
    } catch (cause) {
      setDetail(null);
      setError(messageOf(cause));
    }
  }, [name]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { detail, error, refresh };
}

/**
 * Runs a change and says how it went. A refused save says why in its toast and
 * returns false; the caller keeps what was typed.
 */
export async function runChange(
  action: (pageUrl: string) => Promise<ProfileSaveResult | void>,
  done: string,
  undo?: () => void,
): Promise<boolean> {
  try {
    const result = await action(pageUrl());
    if (result !== undefined && !result.saved) {
      const why = result.issues.find((issue) => issue.level === "error")?.message;
      toastManager.add({
        type: "error",
        title: "Not saved",
        description: why ?? "It didn't pass the check.",
      });
      return false;
    }
    profilesChanged();
    toastManager.add({
      type: "success",
      title: result === undefined ? done : `${done} · v${result.version}`,
      ...(undo === undefined ? {} : { actionProps: { children: "Undo", onClick: undo } }),
    });
    return true;
  } catch (cause) {
    toastManager.add({ type: "error", title: "Not saved", description: messageOf(cause) });
    return false;
  }
}

export { pageUrl };
