// magnesium: which sandbox levels each machine runs, and how to add the rest (goal 03)
import { type HubMachine, hubEnvironmentBasePath, type SandboxList } from "@magnesium/contracts";
import { fetchHubMachines, fetchSandboxes, runHubRequest } from "@magnesium/web";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { useEffect, useState } from "react";

import { Badge } from "../ui/badge";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const hubBaseUrl = () => new URL("/", window.location.origin).toString();

interface MachineSandboxes {
  readonly name: string;
  readonly list: SandboxList | null;
  readonly error: string | null;
}

const LABELS: Record<string, string> = {
  fenced: "Fenced",
  container: "Container",
  native: "Native",
  microvm: "MicroVM",
};

/**
 * Agents run fenced by default on every machine. This lists, for the hub (or a
 * single box) and each machine it carries, which levels run there, what
 * enforces them, and how to enable the ones that don't.
 */
export function SandboxesSection() {
  const [machines, setMachines] = useState<ReadonlyArray<MachineSandboxes>>([]);

  useEffect(() => {
    let cancelled = false;
    const hub = hubBaseUrl();
    const load = (name: string, httpBaseUrl: string) =>
      Effect.runPromise(fetchSandboxes(httpBaseUrl).pipe(Effect.provide(FetchHttpClient.layer)))
        .then((list): MachineSandboxes => ({ name, list, error: null }))
        .catch((error: unknown): MachineSandboxes => ({
          name,
          list: null,
          error: error instanceof Error ? error.message : "Could not reach it.",
        }));
    void (async () => {
      const carried: ReadonlyArray<HubMachine> = await runHubRequest(fetchHubMachines(hub)).catch(
        () => [],
      );
      const results = await Promise.all([
        load("this server", hub),
        ...carried
          .filter((machine) => machine.access === "ready")
          .map((machine) =>
            load(machine.label, new URL(hubEnvironmentBasePath(machine.name), hub).toString()),
          ),
      ]);
      if (!cancelled) setMachines(results);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (machines.length === 0) return null;

  return (
    <SettingsSection title="Sandboxes">
      {machines.map((machine) => (
        <SettingsRow
          key={machine.name}
          title={
            machine.list?.machine && machine.name === "this server"
              ? `${machine.list.machine} (this server)`
              : machine.name
          }
          description={
            machine.list === null ? (
              machine.error
            ) : (
              <span className="flex flex-col gap-1">
                {machine.list.levels
                  .filter((level) => level.level !== "microvm")
                  .map((level) => (
                    <span key={level.level} className="flex flex-wrap items-baseline gap-1.5">
                      <Badge variant={level.available ? "outline" : "secondary"} size="sm">
                        {LABELS[level.level] ?? level.level}
                        {level.available
                          ? level.mechanism
                            ? ` · ${level.mechanism}`
                            : ""
                          : " · off"}
                      </Badge>
                      <span className="text-muted-foreground text-xs">
                        {[level.note, level.enable ? `To enable: ${level.enable}` : null]
                          .filter(Boolean)
                          .join(" ")}
                      </span>
                    </span>
                  ))}
              </span>
            )
          }
        />
      ))}
    </SettingsSection>
  );
}
