// magnesium: a shell on any server the hub carries, opened from Fleet or from a provider's sign-in
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentPresentation } from "../../state/presentation";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";

/** Terminals are keyed by a free-form thread id; machine shells share this one. */
const MACHINE_TERMINAL_THREAD_ID = ThreadId.make("magnesium-machine-terminal");

/**
 * A shell on one environment, in the server's working directory, the way
 * onboarding's setup terminal opens one. A `command` is typed but not run, so
 * you read it and press Enter. Closing the panel ends the shell: nothing keeps
 * running on the machine behind it.
 */
export function MachineTerminal({
  environmentId,
  label,
  command,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly command?: string;
  readonly onClose: () => void;
}) {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const serverConfig = presentation?.serverConfig ?? null;
  const connected = presentation?.connection.phase === "connected" && serverConfig !== null;

  if (!connected || serverConfig === null) {
    return (
      <TerminalFrame
        status={`Connecting to ${label}…`}
        onClose={onClose}
        onRetry={null}
        body={null}
      />
    );
  }
  return (
    <ConnectedTerminal
      environmentId={environmentId}
      label={label}
      command={command}
      cwd={serverConfig.cwd}
      keybindings={serverConfig.keybindings}
      onClose={onClose}
    />
  );
}

function ConnectedTerminal({
  environmentId,
  label,
  command,
  cwd,
  keybindings,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly command: string | undefined;
  readonly cwd: string;
  readonly keybindings: Parameters<typeof TerminalViewport>[0]["keybindings"];
  readonly onClose: () => void;
}) {
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const [terminalId] = useState(() => `machine-${randomUUID()}`);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, MACHINE_TERMINAL_THREAD_ID),
    [environmentId],
  );
  const queueRef = useRef(Promise.resolve());
  const generationRef = useRef(0);
  const activeGenerationRef = useRef<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"opening" | "ready" | "openFailed" | "writeFailed">("opening");

  // Each open is its own generation, so an open that finishes after a newer
  // one started (Strict Mode, Retry) never types into or closes the newer shell.
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    activeGenerationRef.current = generation;
    setState("opening");
    queueRef.current = queueRef.current.then(async () => {
      if (activeGenerationRef.current !== generation) return;
      const opened = await openTerminal({
        environmentId,
        input: { threadId: MACHINE_TERMINAL_THREAD_ID, terminalId, cwd },
      });
      if (activeGenerationRef.current !== generation) return;
      if (opened._tag !== "Success") {
        setState("openFailed");
        return;
      }
      if (command === undefined) {
        setState("ready");
        return;
      }
      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: MACHINE_TERMINAL_THREAD_ID, terminalId, data: command },
      });
      if (activeGenerationRef.current !== generation) return;
      setState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });
    return () => {
      if (activeGenerationRef.current === generation) activeGenerationRef.current = null;
      queueRef.current = queueRef.current.then(async () => {
        await closeTerminal({
          environmentId,
          input: { threadId: MACHINE_TERMINAL_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    attempt,
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    terminalId,
    writeTerminal,
  ]);

  const status =
    state === "openFailed"
      ? `Could not open a terminal on ${label}.`
      : state === "writeFailed" && command !== undefined
        ? `Run ${command} in this terminal.`
        : state === "ready" && command !== undefined
          ? "Read the command, then press Enter to run it."
          : state === "ready"
            ? `Terminal on ${label}`
            : `Opening a terminal on ${label}…`;

  return (
    <TerminalFrame
      status={status}
      onClose={onClose}
      onRetry={state === "openFailed" ? () => setAttempt((value) => value + 1) : null}
      body={
        state === "ready" || state === "writeFailed" ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={MACHINE_TERMINAL_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={`Terminal on ${label}`}
            cwd={cwd}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={320}
            keybindings={keybindings}
          />
        ) : null
      }
    />
  );
}

function TerminalFrame({
  status,
  onClose,
  onRetry,
  body,
}: {
  readonly status: string;
  readonly onClose: () => void;
  readonly onRetry: (() => void) | null;
  readonly body: React.ReactNode;
}) {
  return (
    <div
      data-thread-terminal-drawer
      className="overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="min-w-0 truncate text-2xs font-medium text-muted-foreground">
          {status}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {onRetry !== null ? (
            <Button size="xs" variant="ghost" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="h-80">{body}</div>
    </div>
  );
}
