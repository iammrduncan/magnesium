import {
  fetchSandboxes,
  instanceSandbox,
  sandboxSiblings,
  type SandboxesRequestError,
} from "@magnesium/web";
import type { SandboxLevel, SandboxList } from "@magnesium/contracts";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { BoxIcon, ShieldCheckIcon, ShieldOffIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "../chat/ComposerControl";
import { useComposerMenuProps } from "../chat/composerEventScope";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The sandbox chip next to the model (the Session board's "container" chip).
 * It shows the level the thread's agent runs at, and switches level by
 * switching to the sibling instance that shares the agent's home, so the
 * thread keeps its session. Levels a machine can't run show why, and how to
 * add them; that list loads when the chip opens.
 */

const LEVELS: ReadonlyArray<{
  readonly level: SandboxLevel;
  readonly label: string;
  readonly icon: typeof ShieldCheckIcon;
  readonly blurb: string;
}> = [
  {
    level: "fenced",
    label: "Fenced",
    icon: ShieldCheckIcon,
    blurb: "Can't read or change Magnesium's own files and secrets.",
  },
  {
    level: "container",
    label: "Container",
    icon: BoxIcon,
    blurb: "Sees only the project, its profile and its home.",
  },
  {
    level: "native",
    label: "Native",
    icon: ShieldOffIcon,
    blurb: "No fence. Choose it only for this thread, like full access.",
  },
];

type Loaded =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "loaded"; readonly list: SandboxList }
  | { readonly status: "error"; readonly message: string };

export const SandboxChip = memo(function SandboxChip(props: {
  environmentId: EnvironmentId;
  activeInstanceId: ProviderInstanceId;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  model: string;
  size?: ComposerControlSize;
  isComposerOwned?: boolean;
  disabled?: boolean;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const httpBaseUrl = useEnvironmentHttpBaseUrl(props.environmentId);
  const [loaded, setLoaded] = useState<Loaded>({ status: "idle" });
  const ids = useMemo(
    () => props.instanceEntries.map((entry) => entry.instanceId as string),
    [props.instanceEntries],
  );
  const current = instanceSandbox(props.activeInstanceId, ids);
  const siblings = useMemo(
    () => sandboxSiblings(props.activeInstanceId, ids),
    [props.activeInstanceId, ids],
  );
  if (current === null) return null;
  const size = props.size ?? "sm";
  const currentLevel = LEVELS.find((entry) => entry.level === current.level) ?? LEVELS[0]!;

  const load = () => {
    if (httpBaseUrl === null || loaded.status === "loading" || loaded.status === "loaded") return;
    setLoaded({ status: "loading" });
    void Effect.runPromise(
      fetchSandboxes(httpBaseUrl).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.match({
          onFailure: (error: SandboxesRequestError) =>
            setLoaded({ status: "error", message: error.message }),
          onSuccess: (list) => setLoaded({ status: "loaded", list }),
        }),
      ),
    );
  };

  return (
    <Menu onOpenChange={(open) => open && load()}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size={size}
                  disabled={props.disabled}
                  aria-label={`Sandbox: ${currentLevel.label}`}
                  data-sandbox-chip={current.level}
                  className="shrink-0 whitespace-nowrap"
                />
              }
            />
          }
        >
          <ComposerControlIcon icon={currentLevel.icon} size={size} />
          <span data-composer-control-label>{current.level}</span>
          <ComposerControlChevron size={size} />
        </TooltipTrigger>
        <TooltipPopup side="top">{`Sandbox: ${currentLevel.label}. ${currentLevel.blurb}`}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...(props.isComposerOwned ? composerFloatingLayerProps : {})}>
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Sandbox</div>
          <MenuRadioGroup
            value={props.activeInstanceId}
            onValueChange={(value) => {
              if (typeof value === "string" && value !== props.activeInstanceId) {
                props.onInstanceModelChange(value as ProviderInstanceId, props.model);
              }
            }}
          >
            {LEVELS.map((entry) => {
              const sibling = siblings.find((candidate) => candidate.level === entry.level);
              const info =
                loaded.status === "loaded"
                  ? loaded.list.levels.find((level) => level.level === entry.level)
                  : undefined;
              const unavailable = sibling === undefined || info?.available === false;
              const detail = unavailable
                ? [info?.note, info?.enable ? `To enable: ${info.enable}` : null]
                    .filter(Boolean)
                    .join(" ") ||
                  (loaded.status === "loading" ? "Checking this machine…" : "Not available here.")
                : entry.blurb;
              return (
                <MenuRadioItem
                  key={entry.level}
                  value={sibling?.instanceId ?? `unavailable:${entry.level}`}
                  disabled={unavailable}
                  hideIndicator
                  closeOnClick
                >
                  <span className="flex w-full min-w-0 flex-col">
                    <span className="flex items-center gap-1.5">
                      <entry.icon className="size-3.5 text-muted-foreground" aria-hidden />
                      <span>{entry.label}</span>
                      {sibling?.instanceId === props.activeInstanceId ? (
                        <span className="text-muted-foreground text-xs">(this thread)</span>
                      ) : null}
                    </span>
                    <span className="max-w-64 text-pretty text-muted-foreground/80 text-xs">
                      {detail}
                    </span>
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
          {loaded.status === "error" ? (
            <div className="max-w-64 px-2 pb-1.5 text-destructive text-xs">{loaded.message}</div>
          ) : null}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
