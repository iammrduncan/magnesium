// magnesium: the Profiles page's sections, one tab each (goal 34, D65, D67)
import {
  MAGNESIUM_AGENT_TOOLS,
  MAGNESIUM_MCP_SERVER,
  PROFILE_HARNESS_LABELS,
  PROFILE_HARNESSES,
  type ProfileHarness,
  type ProfileDelivery,
  type ProfileDetail,
  type ProfileEnvironment,
  type ProfileMcpServer,
  type ProfileToolPermission,
} from "@magnesium/contracts";
import {
  describeDelivery,
  deliveryLine,
  instructionsFileProblem,
  KNOWN_INSTRUCTIONS,
  machinesSetting,
  PERMISSION_LABEL,
  permissionLine,
  profileEnvironment,
  putBackProfile,
  saveProfile,
  sendProfilesNow,
  withToolPermission,
} from "@magnesium/web";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { runChange } from "./profilesData";

type Section = {
  readonly detail: ProfileDetail;
  /** Read the profile again after a change. */
  readonly onChanged: () => void;
};

const nameOf = (detail: ProfileDetail) => detail.summary.name;

const withoutKey = <T,>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));

const formatWhen = (iso: string | null) => {
  if (iso === null) return "not yet";
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** A segmented choice between a few values. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      variant="segmented"
      value={[value]}
      onValueChange={(next) => {
        const chosen = next[0] as T | undefined;
        if (chosen !== undefined && chosen !== value) onChange(chosen);
      }}
    >
      {options.map((option) => (
        <Toggle key={option.value} value={option.value} disabled={disabled}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

// Instructions ----------------------------------------------------------------

export function InstructionsSection({ detail, onChanged }: Section) {
  const name = nameOf(detail);
  const saved = useMemo(
    () => new Map(detail.files.map((file) => [file.path, file.content])),
    [detail.files],
  );
  const [added, setAdded] = useState<ReadonlyArray<string>>([]);
  const paths = [
    ...detail.files.map((file) => file.path),
    ...added.filter((path) => !saved.has(path)),
  ];
  const [selected, setSelected] = useState(paths[0] ?? "AGENTS.md");
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  const current = paths.includes(selected) ? selected : (paths[0] ?? "AGENTS.md");
  const base = saved.get(current) ?? "";
  const text = drafts[current] ?? base;
  // After a save the hub's copy matches the draft, so the draft reads as saved.
  const dirty = text !== base || !saved.has(current);
  const problem = newName === "" ? undefined : instructionsFileProblem(newName, paths);
  const editable = detail.editable;

  const save = async () => {
    setBusy(true);
    const ok = await runChange(
      (url) => saveProfile(url, { name, files: [{ path: current, content: text }] }),
      `Saved ${current}`,
    );
    setBusy(false);
    if (ok) onChanged();
  };
  const remove = async () => {
    if (!saved.has(current)) {
      setAdded((list) => list.filter((path) => path !== current));
      setSelected("AGENTS.md");
      return;
    }
    setBusy(true);
    const ok = await runChange(
      (url) => saveProfile(url, { name, files: [{ path: current, content: null }] }),
      `Removed ${current}`,
    );
    setBusy(false);
    if (ok) {
      setSelected("AGENTS.md");
      onChanged();
    }
  };
  const add = (file: string) => {
    if (instructionsFileProblem(file, paths) !== undefined) return;
    setAdded((list) => [...list, file]);
    setDrafts((all) => ({
      ...all,
      [file]: file === "MEMORIES.md" ? "" : `# ${file.replace(/\.md$/, "")}\n\n`,
    }));
    setSelected(file);
    setAdding(false);
    setNewName("");
  };

  return (
    <div className="flex flex-wrap gap-4">
      <div className="flex w-44 shrink-0 flex-col gap-1">
        <ul className="flex flex-col gap-0.5" aria-label="Instructions files">
          {paths.map((path) => {
            const known = KNOWN_INSTRUCTIONS.find((file) => file.name === path)?.about;
            const unsaved =
              !saved.has(path) || (drafts[path] !== undefined && drafts[path] !== saved.get(path));
            return (
              <li key={path}>
                <Button
                  variant={path === current ? "secondary" : "ghost"}
                  size="sm-multiline"
                  className="w-full justify-start"
                  onClick={() => setSelected(path)}
                  aria-current={path === current}
                >
                  <span className="flex min-w-0 flex-col items-start">
                    <span className="font-mono text-xs">{path}</span>
                    <span className="text-2xs text-muted-foreground">
                      {unsaved
                        ? "Unsaved"
                        : path === "AGENTS.md"
                          ? "Required"
                          : (known ?? "Named in AGENTS.md")}
                    </span>
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
        {editable && adding ? (
          <form
            className="flex flex-col gap-2 rounded-lg border border-border p-2"
            onSubmit={(event) => {
              event.preventDefault();
              add(newName.trim());
            }}
          >
            <label htmlFor="profile-new-file" className="text-xs text-muted-foreground">
              File name
            </label>
            <Input
              id="profile-new-file"
              size="sm"
              value={newName}
              placeholder="RUNBOOK.md"
              onChange={(event) => setNewName(event.target.value)}
              aria-invalid={problem !== undefined}
            />
            {problem ? <p className="text-xs text-destructive-foreground">{problem}</p> : null}
            <div className="flex flex-wrap gap-1">
              {KNOWN_INSTRUCTIONS.filter((file) => !paths.includes(file.name)).map((file) => (
                <Button
                  key={file.name}
                  size="micro"
                  variant="outline"
                  title={file.about}
                  onClick={() => add(file.name)}
                >
                  {file.name}
                </Button>
              ))}
            </div>
            <div className="flex justify-end gap-1">
              <Button size="xs" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button size="xs" type="submit" disabled={newName === "" || problem !== undefined}>
                Add
              </Button>
            </div>
          </form>
        ) : editable ? (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add a file
          </Button>
        ) : null}
      </div>
      <div className="flex min-w-72 flex-1 flex-col gap-2">
        <label htmlFor="profile-file-editor" className="text-xs text-muted-foreground">
          {current}
          {current === "AGENTS.md"
            ? " · every harness reads it"
            : current === "CLAUDE.md"
              ? " · Claude Code reads it after AGENTS.md"
              : current === "MEMORIES.md"
                ? " · notes kept between sessions"
                : current === "CONVENTIONS.md"
                  ? " · house rules"
                  : " · joins the instructions on every machine"}
        </label>
        <div className="font-mono">
          <Textarea
            id="profile-file-editor"
            size="lg"
            value={text}
            readOnly={!editable}
            spellCheck={false}
            onChange={(event) => setDrafts((all) => ({ ...all, [current]: event.target.value }))}
          />
        </div>
        {editable ? (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "text-xs",
                dirty ? "text-warning-foreground" : "text-success-foreground",
              )}
            >
              {dirty ? "Not saved" : "Saved · checked"}
            </span>
            <span className="flex-1" />
            {current === "AGENTS.md" ? null : (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => void remove()}
              >
                Remove file
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || drafts[current] === undefined}
              onClick={() => setDrafts((all) => withoutKey(all, current))}
            >
              Revert
            </Button>
            <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
              Save
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Skills ----------------------------------------------------------------------

const SKILL_TEMPLATE = (skill: string) =>
  `---\nname: ${skill}\ndescription: What this skill does, in one line.\n---\n\n# ${skill}\n\nSay when to use it and how.\n`;

export function SkillsSection({ detail, onChanged }: Section) {
  const name = nameOf(detail);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newSkill, setNewSkill] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = detail.editable;
  const valid =
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(newSkill) &&
    !detail.skills.some((skill) => skill.name === newSkill);

  const write = async (
    files: ReadonlyArray<{ path: string; content: string | null }>,
    done: string,
  ) => {
    setBusy(true);
    const ok = await runChange((url) => saveProfile(url, { name, files: [...files] }), done);
    setBusy(false);
    if (ok) onChanged();
    return ok;
  };

  return (
    <div className="flex flex-col gap-3">
      {detail.skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No skills yet. A skill is a folder with a SKILL.md the agent reads when it needs it.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {detail.skills.map((skill) => {
            const main = skill.files.find((file) => file.path.endsWith("/SKILL.md"));
            const isOpen = open === skill.name;
            return (
              <li key={skill.name} className="flex flex-col gap-2 px-3 py-2">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-48 flex-1">
                    <div className="text-sm font-medium text-foreground">{skill.name}</div>
                    <div className="text-xs text-muted-foreground">{skill.description}</div>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {skill.files.length} {skill.files.length === 1 ? "file" : "files"}
                  </span>
                  {editable ? (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setOpen(isOpen ? null : skill.name);
                          setDraft(main?.content ?? SKILL_TEMPLATE(skill.name));
                        }}
                      >
                        {isOpen ? "Close" : "Edit"}
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        disabled={busy}
                        onClick={() =>
                          void write(
                            skill.files.map((file) => ({ path: file.path, content: null })),
                            `Removed ${skill.name}`,
                          )
                        }
                      >
                        Remove
                      </Button>
                    </>
                  ) : null}
                </div>
                {isOpen ? (
                  <div className="flex flex-col gap-2">
                    <div className="font-mono">
                      <Textarea
                        aria-label={`${skill.name}'s SKILL.md`}
                        value={draft}
                        spellCheck={false}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                    </div>
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        disabled={busy || draft === main?.content}
                        onClick={() =>
                          void write(
                            [{ path: `skills/${skill.name}/SKILL.md`, content: draft }],
                            `Saved ${skill.name}`,
                          ).then((ok) => ok && setOpen(null))
                        }
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {editable ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            void write(
              [{ path: `skills/${newSkill}/SKILL.md`, content: SKILL_TEMPLATE(newSkill) }],
              `Added ${newSkill}`,
            ).then((ok) => {
              if (ok) {
                setOpen(newSkill);
                setDraft(SKILL_TEMPLATE(newSkill));
                setNewSkill("");
              }
            });
          }}
        >
          <Input
            aria-label="New skill's name"
            size="sm"
            className="w-56"
            placeholder="new-skill"
            value={newSkill}
            onChange={(event) => setNewSkill(event.target.value)}
          />
          <Button size="sm" variant="outline" type="submit" disabled={!valid || busy}>
            Add a skill
          </Button>
        </form>
      ) : null}
    </div>
  );
}

// Tools -----------------------------------------------------------------------

const PERMISSIONS: ReadonlyArray<{ value: ProfileToolPermission; label: string }> = [
  { value: "allow", label: PERMISSION_LABEL.allow },
  { value: "ask", label: PERMISSION_LABEL.ask },
  { value: "off", label: PERMISSION_LABEL.off },
];

/** Magnesium's own tools an agent has, and what they do. */
const OWN_TOOLS = Object.entries(MAGNESIUM_AGENT_TOOLS).map(([name, tool]) => ({
  name,
  about: tool.about,
}));

function ServerRow({
  server,
  editable,
  onPermissions,
  onRemove,
}: {
  readonly server: ProfileMcpServer;
  readonly editable: boolean;
  readonly onPermissions: (next: ProfileMcpServer["permissions"]) => void;
  readonly onRemove: () => void;
}) {
  const own = server.name === MAGNESIUM_MCP_SERVER;
  const [open, setOpen] = useState(false);
  const [newTool, setNewTool] = useState("");
  const tools = own
    ? OWN_TOOLS.map((tool) => ({
        ...tool,
        permission: server.permissions.tools[tool.name] ?? server.permissions.default,
      }))
    : Object.entries(server.permissions.tools).map(([tool, permission]) => ({
        name: tool,
        about: "",
        permission,
      }));
  return (
    <li className="flex flex-col gap-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${server.name}'s tools`}
          onClick={() => setOpen(!open)}
        >
          <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
        </Button>
        <div className="flex min-w-56 flex-1 flex-col">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium text-foreground">{server.name}</span>
            <span className="text-xs text-muted-foreground">{permissionLine(server)}</span>
          </span>
          <code className="truncate text-xs text-muted-foreground">{server.how}</code>
          {server.secrets.length > 0 ? (
            <span className="mt-1 flex flex-wrap gap-1">
              {server.secrets.map((secret) => (
                <Badge key={secret} variant="outline" size="sm">
                  <code>{secret}</code>
                </Badge>
              ))}
            </span>
          ) : null}
        </div>
        {editable && !own ? (
          <Button size="xs" variant="destructive-outline" onClick={onRemove}>
            Remove
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-1 pl-8">
          {tools.map((tool) => (
            <div
              key={tool.name}
              className="flex flex-wrap items-center gap-3 border-t border-border py-1.5"
            >
              <code className="w-48 shrink-0 text-xs text-foreground">{tool.name}</code>
              <span className="min-w-40 flex-1 text-xs text-muted-foreground">{tool.about}</span>
              <Choice
                label={tool.name}
                value={tool.permission}
                options={PERMISSIONS}
                disabled={!editable}
                onChange={(permission) =>
                  onPermissions(withToolPermission(server.permissions, tool.name, permission))
                }
              />
            </div>
          ))}
          {own ? (
            <p className="text-xs text-muted-foreground">
              A change an agent asks for always waits for your approval, whatever is set here.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3 border-t border-border py-1.5">
              <span className="w-48 shrink-0 text-xs text-foreground">The rest of its tools</span>
              <span className="min-w-40 flex-1 text-xs text-muted-foreground">
                Name a tool to set it on its own.
              </span>
              <Choice
                label={`The rest of ${server.name}'s tools`}
                value={server.permissions.default}
                options={PERMISSIONS}
                disabled={!editable}
                onChange={(value) =>
                  onPermissions({ default: value, tools: server.permissions.tools })
                }
              />
            </div>
          )}
          {editable && !own ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const tool = newTool.trim();
                if (tool === "" || tool in server.permissions.tools) return;
                onPermissions(
                  withToolPermission(server.permissions, tool, server.permissions.default),
                );
                setNewTool("");
              }}
            >
              <Input
                aria-label={`A tool of ${server.name}`}
                size="sm"
                className="w-56"
                placeholder="tool_name"
                value={newTool}
                onChange={(event) => setNewTool(event.target.value)}
              />
              <Button size="xs" variant="outline" type="submit" disabled={newTool.trim() === ""}>
                Name a tool
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ToolsSection({ detail, onChanged }: Section) {
  const name = nameOf(detail);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ server: "", url: "", command: "", secret: "" });
  // The hub's MCP server, where an agent signs in once (see the outside-agents guide).
  const mcpUrl = new URL("/mcp", window.location.href).toString();
  const servers = useMemo((): Record<string, unknown> => {
    try {
      return detail.mcpJson === null
        ? {}
        : ((JSON.parse(detail.mcpJson) as { mcpServers?: Record<string, unknown> }).mcpServers ??
            {});
    } catch {
      return {};
    }
  }, [detail.mcpJson]);

  const setPermissions = (server: string, permissions: ProfileMcpServer["permissions"]) =>
    void runChange(
      (url) => saveProfile(url, { name, settings: { toolPermissions: { [server]: permissions } } }),
      `${server}'s tools changed`,
    ).then((ok) => ok && onChanged());

  const writeServers = (next: Record<string, unknown>, done: string, removed?: string) =>
    void runChange(
      (url) =>
        saveProfile(url, {
          name,
          files: [
            {
              path: "mcp.json",
              content:
                Object.keys(next).length === 0
                  ? null
                  : `${JSON.stringify({ mcpServers: next }, null, 2)}\n`,
            },
          ],
          ...(removed === undefined ? {} : { settings: { toolPermissions: { [removed]: null } } }),
        }),
      done,
    ).then((ok) => ok && onChanged());

  const validName =
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(form.server) &&
    !(form.server in servers) &&
    form.server !== MAGNESIUM_MCP_SERVER;
  const secret = form.secret.trim();
  const validSecret = secret === "" || /^[A-Z_][A-Z0-9_]*$/.test(secret);
  const addServer = () => {
    const entry =
      form.url.trim() !== ""
        ? {
            type: "http",
            url: form.url.trim(),
            ...(secret === "" ? {} : { headers: { Authorization: `Bearer \${${secret}}` } }),
          }
        : (() => {
            const [command, ...args] = form.command.trim().split(/\s+/);
            return {
              command,
              ...(args.length > 0 ? { args } : {}),
              ...(secret === "" ? {} : { env: { [secret]: `\${${secret}}` } }),
            };
          })();
    writeServers({ ...servers, [form.server]: entry }, `Added ${form.server}`);
    setAdding(false);
    setForm({ server: "", url: "", command: "", secret: "" });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2">
        <span className="min-w-60 flex-1 text-sm">
          Magnesium's own tools are on the hub's MCP server. Point an agent outside Magnesium at
          this address: it signs in once, and you choose what it may do.
        </span>
        <code className="text-xs text-muted-foreground">{mcpUrl}</code>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(mcpUrl);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy MCP URL"}
        </Button>
      </div>
      {detail.harnesses.includes("opencode") ? (
        <p className="text-xs text-muted-foreground">
          On OpenCode, a thread's permission mode comes after these settings: in Supervised every
          tool still asks, and in full access every tool runs.
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {detail.mcpServers.map((server) => (
          <ServerRow
            key={server.name}
            server={server}
            editable={detail.editable}
            onPermissions={(permissions) => setPermissions(server.name, permissions)}
            onRemove={() => {
              writeServers(withoutKey(servers, server.name), `Removed ${server.name}`, server.name);
            }}
          />
        ))}
      </ul>
      {detail.editable && adding ? (
        <form
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (validName && validSecret && (form.url.trim() !== "" || form.command.trim() !== ""))
              addServer();
          }}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
              Name
              <Input
                size="sm"
                value={form.server}
                placeholder="grafana"
                onChange={(event) => setForm({ ...form, server: event.target.value })}
              />
            </label>
            <label className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
              Its secret, by variable name (optional)
              <Input
                size="sm"
                value={form.secret}
                placeholder="GRAFANA_TOKEN"
                onChange={(event) => setForm({ ...form, secret: event.target.value })}
                aria-invalid={!validSecret}
              />
            </label>
            <label className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
              URL
              <Input
                size="sm"
                value={form.url}
                placeholder="https://grafana.example/mcp"
                onChange={(event) => setForm({ ...form, url: event.target.value, command: "" })}
              />
            </label>
            <label className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
              Or a command
              <Input
                size="sm"
                value={form.command}
                placeholder="kube-mcp --read-only"
                onChange={(event) => setForm({ ...form, command: event.target.value, url: "" })}
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            The secret's value stays in each machine's environment; the profile holds only its name.
            Its tools ask first until you allow them.
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              disabled={
                !validName || !validSecret || (form.url.trim() === "" && form.command.trim() === "")
              }
            >
              Add
            </Button>
          </div>
        </form>
      ) : detail.editable ? (
        <div>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            Add an MCP server
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// Environment -----------------------------------------------------------------

export function EnvironmentSection({ detail, onChanged }: Section) {
  const name = nameOf(detail);
  const [newName, setNewName] = useState("");
  const [presence, setPresence] = useState<ProfileEnvironment | null>(null);
  // The page remounts this tab on each new version, so it asks again after a save.
  useEffect(() => {
    let current = true;
    profileEnvironment(window.location.href, name)
      .then((next) => current && setPresence(next))
      .catch(() => current && setPresence(null));
    return () => {
      current = false;
    };
  }, [name]);
  const names = [
    ...new Set([...detail.env, ...detail.mcpServers.flatMap((server) => server.secrets)]),
  ];
  const valid = /^[A-Z_][A-Z0-9_]*$/.test(newName) && !detail.env.includes(newName);
  const setEnv = (env: ReadonlyArray<string>, done: string) =>
    void runChange((url) => saveProfile(url, { name, settings: { env: [...env] } }), done).then(
      (ok) => ok && onChanged(),
    );
  const machines = presence?.machines ?? [];
  return (
    <div className="flex flex-col gap-3">
      {names.length === 0 ? (
        <p className="text-sm text-muted-foreground">It needs no environment variables.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-96 border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Variable</th>
                {machines.map((machine) => (
                  <th key={machine.machine} className="px-3 py-2 font-medium">
                    {machine.machine}
                  </th>
                ))}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {names.map((variable) => {
                const usedBy = detail.mcpServers
                  .filter((server) => server.secrets.includes(variable))
                  .map((server) => server.name);
                return (
                  <tr key={variable} className="border-t border-border">
                    <td className="px-3 py-2">
                      <code className="text-foreground">{variable}</code>
                      <div className="text-xs text-muted-foreground">
                        {usedBy.length > 0 ? `For ${usedBy.join(", ")}` : "Passed to the agent"}
                      </div>
                    </td>
                    {machines.map((machine) => {
                      const state = !machine.reachable
                        ? { text: "Can't ask", tone: "text-muted-foreground" }
                        : machine.set.includes(variable)
                          ? { text: "Set", tone: "text-success-foreground" }
                          : { text: "Missing", tone: "text-warning-foreground font-medium" };
                      return (
                        <td key={machine.machine} className={cn("px-3 py-2 text-xs", state.tone)}>
                          {state.text}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right">
                      {detail.editable && detail.env.includes(variable) ? (
                        <Button
                          size="xs"
                          variant="ghost-destructive"
                          onClick={() =>
                            setEnv(
                              detail.env.filter((value) => value !== variable),
                              `Removed ${variable}`,
                            )
                          }
                        >
                          Remove
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Only names are kept: a value is never shown, sent or stored here. Set a missing one in that
        machine's environment.
      </p>
      {detail.editable ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) {
              setEnv([...detail.env, newName], `Added ${newName}`);
              setNewName("");
            }
          }}
        >
          <Input
            aria-label="A variable name"
            size="sm"
            className="w-56"
            placeholder="HF_TOKEN"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button size="sm" variant="outline" type="submit" disabled={!valid}>
            Add a variable
          </Button>
        </form>
      ) : null}
    </div>
  );
}

// Runs on ---------------------------------------------------------------------

export function RunsOnSection({
  detail,
  onChanged,
  machines,
}: Section & { readonly machines: ReadonlyArray<string> }) {
  const name = nameOf(detail);
  const named = detail.summary.machines.filter((machine) => machine !== "*");
  const [every, setEvery] = useState(detail.everyMachine);
  const [picked, setPicked] = useState<ReadonlyArray<string>>(named);
  const [harnesses, setHarnesses] = useState<ReadonlyArray<string>>(detail.harnesses);
  const [sandbox, setSandbox] = useState(
    detail.summary.sandbox === "container" ? "container" : "fenced",
  );
  const [args, setArgs] = useState(detail.launchArgs.join(" "));
  const [displayName, setDisplayName] = useState(detail.summary.displayName);
  const [accent, setAccent] = useState(detail.summary.accentColor);
  const choices = [...new Set([...machines, ...named])].toSorted();
  const editable = detail.editable;

  const save = () =>
    void runChange(
      (url) =>
        saveProfile(url, {
          name,
          settings: {
            machines: machinesSetting(every, picked),
            harnesses: harnesses.filter((harness): harness is ProfileHarness =>
              (PROFILE_HARNESSES as ReadonlyArray<string>).includes(harness),
            ),
            sandbox: sandbox === "container" ? "container" : "fenced",
            launchArgs: args.trim() === "" ? [] : args.trim().split(/\s+/),
            displayName: displayName.trim() === name ? null : displayName,
            accentColor: accent,
          },
        }),
      "Saved where it runs",
    ).then((ok) => ok && onChanged());

  return (
    <div className="flex flex-col gap-4">
      <fieldset
        className="flex flex-col gap-2 rounded-lg border border-border p-3"
        disabled={!editable}
      >
        <legend className="px-1 text-xs text-muted-foreground">Machines</legend>
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox checked={every} onCheckedChange={(checked) => setEvery(checked === true)} />
          Every machine, new ones included
        </label>
        <p className="text-xs text-muted-foreground">
          {every
            ? "It goes to every machine the hub has, and to new ones as they join. Untick it to choose."
            : "It goes only to the machines ticked here."}
        </p>
        <div
          className={cn("grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3", every && "opacity-64")}
        >
          {choices.map((machine) => (
            <label key={machine} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={every || picked.includes(machine)}
                disabled={every}
                onCheckedChange={(checked) =>
                  setPicked((list) =>
                    checked === true
                      ? [...list, machine]
                      : list.filter((value) => value !== machine),
                  )
                }
              />
              {machine}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <fieldset
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
          disabled={!editable}
        >
          <legend className="px-1 text-xs text-muted-foreground">Harnesses</legend>
          {PROFILE_HARNESSES.map((value) => ({ value, label: PROFILE_HARNESS_LABELS[value] })).map(
            (harness) => (
              <label key={harness.value} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={harnesses.includes(harness.value)}
                  onCheckedChange={(checked) =>
                    setHarnesses((list) =>
                      checked === true
                        ? [...list, harness.value]
                        : list.length > 1
                          ? list.filter((value) => value !== harness.value)
                          : list,
                    )
                  }
                />
                {harness.label}
              </label>
            ),
          )}
        </fieldset>
        <fieldset
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
          disabled={!editable}
        >
          <legend className="px-1 text-xs text-muted-foreground">Default sandbox</legend>
          <Choice
            label="Default sandbox"
            value={sandbox}
            options={[
              { value: "fenced", label: "fenced" },
              { value: "container", label: "container" },
            ]}
            disabled={!editable}
            onChange={setSandbox}
          />
          <p className="text-xs text-muted-foreground">
            Native stays a choice per thread, never a default.
          </p>
        </fieldset>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
          Display name
          <Input
            size="sm"
            value={displayName}
            readOnly={!editable}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
          Accent
          <input
            type="color"
            aria-label="Accent"
            value={accent}
            disabled={!editable}
            onChange={(event) => setAccent(event.target.value)}
            className="h-8 w-16 cursor-pointer rounded-md border border-input bg-transparent"
          />
        </label>
        <label className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
          Launch arguments
          <span className="w-full font-mono">
            <Input
              size="sm"
              value={args}
              readOnly={!editable}
              onChange={(event) => setArgs(event.target.value)}
            />
          </span>
        </label>
      </div>
      {editable ? (
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground">
            Saving checks it first; a refused change leaves the machines as they are.
          </span>
          <Button
            size="sm"
            onClick={save}
            disabled={!every && picked.length === 0 && choices.length > 0}
          >
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// Brain -----------------------------------------------------------------------

export function BrainSection({ detail }: Section) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-4">
      <p className="text-sm text-foreground">
        What {detail.summary.displayName} may read and write in the Brain goes here, section by
        section.
      </p>
      <p className="text-sm text-muted-foreground">
        Magnesium's own Brain comes with goal 29; until then a profile reaches a knowledge base only
        as an MCP server under Tools. The Brain's own settings, its sections and sources, stay in
        the Brain.
      </p>
    </div>
  );
}

// History ---------------------------------------------------------------------

export function HistorySection({ detail, onChanged }: Section) {
  const name = nameOf(detail);
  const [busy, setBusy] = useState<number | null>(null);
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {detail.history.map((entry, index) => (
        <li key={entry.version} className="flex flex-wrap items-center gap-3 px-3 py-2">
          <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
            v{entry.version}
          </span>
          <div className="min-w-56 flex-1">
            <div className="text-sm text-foreground">{entry.summary}</div>
            <div className="text-xs text-muted-foreground">
              {entry.by} · {formatWhen(entry.at)}
            </div>
          </div>
          {index === 0 ? (
            <Badge variant="success" size="sm">
              Current
            </Badge>
          ) : detail.editable ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                setBusy(entry.version);
                void runChange(
                  (url) => putBackProfile(url, name, entry.version),
                  `Put back v${entry.version}`,
                )
                  .then((ok) => ok && onChanged())
                  .finally(() => setBusy(null));
              }}
            >
              Put back
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// Delivery --------------------------------------------------------------------

const DELIVERY_DOT: Record<ReturnType<typeof describeDelivery>["tone"], string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

export function DeliveryPanel({ detail, onChanged }: Section) {
  const [sent, setSent] = useState(false);
  return (
    <aside aria-label="Delivery" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Delivery
        </h2>
        {detail.deliveries.length > 0 && detail.editable ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void runChange(
                (url) => sendProfilesNow(url),
                "Sent to every machine that is up",
              ).then((ok) => {
                if (ok) {
                  setSent(true);
                  window.setTimeout(onChanged, 1500);
                }
              })
            }
          >
            {sent ? "Sent" : "Send now"}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {deliveryLine(detail.deliveries, detail.version)}
      </p>
      {detail.deliveries.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {detail.deliveries.map((delivery: ProfileDelivery) => {
            const state = describeDelivery(delivery);
            return (
              <li key={delivery.machine} className="flex items-center gap-2 px-3 py-2">
                <span
                  className={cn("size-2 shrink-0 rounded-full", DELIVERY_DOT[state.tone])}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">{delivery.machine}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {delivery.detail ?? `checked ${formatWhen(delivery.checkedAt)}`}
                  </div>
                </div>
                <span className="text-xs font-medium text-muted-foreground">{state.label}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </aside>
  );
}
