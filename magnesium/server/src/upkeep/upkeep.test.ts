// @effect-diagnostics nodeBuiltinImport:off - the tests lay out a release root and a state home on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { backupTimeOf, launcherOf, make, releaseRootOf, type UpkeepConfig } from "./Upkeep.ts";

const realScript = NodePath.resolve(import.meta.dirname, "../../../deploy/bin/magnesium-release");

/** A release root with releases `aaaaaaa` (current) and `bbbbbbb` (previous), and a state home. */
const layout = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mg-upkeep-"));
  for (const name of ["aaaaaaa", "bbbbbbb"]) {
    const server = NodePath.join(root, "releases", name, "apps/server/dist");
    NodeFS.mkdirSync(server, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(server, "bin.mjs"), "");
  }
  NodeFS.symlinkSync("releases/aaaaaaa", NodePath.join(root, "current"));
  NodeFS.symlinkSync("releases/bbbbbbb", NodePath.join(root, "previous"));
  const home = NodePath.join(root, "state");
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(home, "userdata/settings.json"), "{}");
  return { root, home, cleanup: () => NodeFS.rmSync(root, { recursive: true, force: true }) };
};

/** A stand-in `magnesium-release` that prints `out` and `err` and exits with `code`. */
const stubScript = (dir: string, out: string, err = "", code = 0) => {
  const file = NodePath.join(dir, "stub-release");
  NodeFS.writeFileSync(
    file,
    `printf '%b' ${JSON.stringify(out)}\nprintf '%b' ${JSON.stringify(err)} >&2\nexit ${code}\n`,
  );
  return file;
};

const withUpkeep = <A, E, R>(
  overrides: Partial<UpkeepConfig>,
  body: (
    upkeep: Effect.Success<ReturnType<typeof make>>,
    place: ReturnType<typeof layout>,
    stops: Ref.Ref<number>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const place = layout();
    yield* Effect.addFinalizer(() => Effect.sync(place.cleanup));
    const stops = yield* Ref.make(0);
    const upkeep = yield* make({
      home: place.home,
      root: place.root,
      release: "aaaaaaa",
      script: realScript,
      launcher: "systemd",
      source: null,
      stop: Ref.update(stops, (n) => n + 1),
      ...overrides,
    });
    return yield* body(upkeep, place, stops);
  }).pipe(Effect.provide(NodeServices.layer));

const pendingOf = (home: string) =>
  NodeFS.readFileSync(NodePath.join(home, "upkeep/pending"), "utf8").trim();

describe("a server's upkeep", () => {
  it("reads what the deploy says about a server", () => {
    expect(backupTimeOf("20261020T030512Z")).toBe("2026-10-20T03:05:12.000Z");
    expect(backupTimeOf("20261020T030512Z-4711")).toBe("2026-10-20T03:05:12.000Z");
    expect(backupTimeOf("partial")).toBeNull();
    expect(
      releaseRootOf(
        "/home/agent/.local/share/magnesium/releases/1a2b3c4d5e/apps/server/dist/bin.mjs",
      ),
    ).toBe("/home/agent/.local/share/magnesium");
    expect(releaseRootOf("/home/agent/magnesium/apps/server/src/bin.ts")).toBeNull();
    expect(launcherOf("systemd")).toBe("systemd");
    expect(launcherOf("launchd")).toBeNull();
  });

  it.live("backs itself up through magnesium-release and says when", () =>
    withUpkeep({}, (upkeep, place) =>
      Effect.gen(function* () {
        expect(upkeep.previousRelease).toBe("bbbbbbb");
        expect((yield* upkeep.state).backups).toEqual({
          newestAt: null,
          newestBytes: null,
          count: 0,
          failure: null,
        });

        const made = yield* upkeep.backupNow;
        expect(made.name).toMatch(/^\d{8}T\d{6}Z/);
        expect(made.bytes).toBe(2);
        expect(NodeFS.existsSync(NodePath.join(place.home, "backups", made.name))).toBe(true);
        expect((yield* upkeep.backups).backups.map((backup) => backup.name)).toEqual([made.name]);
        expect((yield* upkeep.state).backups).toEqual({
          newestAt: made.at,
          newestBytes: 2,
          count: 1,
          failure: null,
        });
      }),
    ),
  );

  it.live("says why a backup failed until a newer one succeeds", () =>
    withUpkeep({}, (upkeep, place) =>
      Effect.gen(function* () {
        const failing = make({
          home: place.home,
          root: place.root,
          release: "aaaaaaa",
          script: stubScript(place.root, "", "magnesium-release: no space left on device\n", 1),
          launcher: "systemd",
          source: null,
          stop: Effect.void,
        });
        const broken = yield* failing;
        const error = yield* broken.backupNow.pipe(Effect.flip);
        expect(error.detail).toBe("The backup failed: no space left on device");
        expect((yield* broken.state).backups.failure?.reason).toBe("no space left on device");

        // The real script works again: the failure is behind the newest backup now.
        yield* upkeep.backupNow;
        expect((yield* upkeep.state).backups.failure).toBeNull();
      }),
    ),
  );

  it.live("leaves a restore for its launcher, then stops", () =>
    withUpkeep({}, (upkeep, place, stops) =>
      Effect.gen(function* () {
        const made = yield* upkeep.backupNow;
        yield* upkeep.restore(made.name);
        expect(pendingOf(place.home)).toBe(`restore ${made.name}`);
        expect((yield* upkeep.state).activity?.kind).toBe("restore");
        yield* Effect.sleep("700 millis");
        expect(yield* Ref.get(stops)).toBe(1);

        const missing = yield* upkeep.restore("20000101T000000Z").pipe(Effect.flip);
        expect(missing.detail).toContain("Busy");
      }),
    ),
  );

  it.live("rolls back and updates through its launcher, only where releases are its own", () =>
    Effect.gen(function* () {
      yield* withUpkeep({}, (upkeep, place) =>
        Effect.gen(function* () {
          const notHere = yield* upkeep.update({ release: "ccccccc" }).pipe(Effect.flip);
          expect(notHere.detail).toBe("ccccccc isn't on this server.");
          const same = yield* upkeep.update({ release: "aaaaaaa" }).pipe(Effect.flip);
          expect(same.detail).toBe("This server is already on aaaaaaa.");
          yield* upkeep.rollback;
          expect(pendingOf(place.home)).toBe("activate bbbbbbb rollback");
        }),
      );
      yield* withUpkeep({}, (upkeep, place) =>
        Effect.gen(function* () {
          yield* upkeep.update({ release: "bbbbbbb" });
          expect(pendingOf(place.home)).toBe("activate bbbbbbb update");
        }),
      );
      yield* withUpkeep({ launcher: "container" }, (upkeep) =>
        Effect.gen(function* () {
          const error = yield* upkeep.rollback.pipe(Effect.flip);
          expect(error.detail).toBe(
            "This server's build comes from its image, so it can't roll back by itself.",
          );
        }),
      );
      yield* withUpkeep({ launcher: null }, (upkeep) =>
        Effect.gen(function* () {
          const error = yield* upkeep.restore("20000101T000000Z").pipe(Effect.flip);
          expect(error.detail).toContain("Nothing restarts this server");
        }),
      );
    }),
  );

  it.live("builds a release from its own source first, and says when that fails", () =>
    withUpkeep({}, (_, place) =>
      Effect.gen(function* () {
        const building = yield* make({
          home: place.home,
          root: place.root,
          release: "aaaaaaa",
          script: stubScript(
            place.root,
            "Built ccccccc1234. Run: magnesium-release activate ccccccc1234\n",
          ),
          launcher: "systemd",
          source: "https://example.com/magnesium.git",
          stop: Effect.void,
        });
        yield* building.update({ release: "ccccccc1234", build: true });
        yield* Effect.sleep("300 millis");
        expect(pendingOf(place.home)).toBe("activate ccccccc1234 update");

        NodeFS.rmSync(NodePath.join(place.home, "upkeep/pending"));
        const failing = yield* make({
          home: place.home,
          root: place.root,
          release: "aaaaaaa",
          script: stubScript(place.root, "", "magnesium-release: unknown ref ddddddd\n", 1),
          launcher: "systemd",
          source: "https://example.com/magnesium.git",
          stop: Effect.void,
        });
        yield* failing.update({ release: "ddddddd", build: true });
        yield* Effect.sleep("300 millis");
        expect(NodeFS.existsSync(NodePath.join(place.home, "upkeep/pending"))).toBe(false);
        expect((yield* failing.state).lastResult).toMatchObject({
          kind: "update",
          to: "ddddddd",
          ok: false,
          detail: "The build of ddddddd failed: unknown ref ddddddd",
        });

        const noSource = yield* make({
          home: place.home,
          root: place.root,
          release: "aaaaaaa",
          script: realScript,
          launcher: "systemd",
          source: null,
          stop: Effect.void,
        });
        const error = yield* noSource.update({ release: "ddddddd", build: true }).pipe(Effect.flip);
        expect(error.detail).toBe("This server has no source to build from: set MAGNESIUM_SOURCE.");
      }),
    ),
  );

  it.live("ends a new release's trial once it has run a while", () =>
    Effect.gen(function* () {
      const place = layout();
      yield* Effect.addFinalizer(() => Effect.sync(place.cleanup));
      NodeFS.mkdirSync(NodePath.join(place.home, "upkeep"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(place.home, "upkeep/trial"), "update bbbbbbb aaaaaaa 1\n");
      NodeFS.writeFileSync(
        NodePath.join(place.home, "upkeep/result.json"),
        '{"kind":"update","from":"bbbbbbb","to":"aaaaaaa","ok":true,"detail":"Starting on aaaaaaa.","at":"2026-10-20T03:00:00Z"}\n',
      );
      const upkeep = yield* make({
        home: place.home,
        root: place.root,
        release: "aaaaaaa",
        script: realScript,
        launcher: "systemd",
        source: null,
        stop: Effect.void,
        settledAfter: Duration.millis(100),
      });
      expect((yield* upkeep.state).lastResult?.detail).toBe("Starting on aaaaaaa.");
      yield* Effect.sleep("400 millis");
      expect(NodeFS.existsSync(NodePath.join(place.home, "upkeep/trial"))).toBe(false);
      expect((yield* upkeep.state).lastResult).toMatchObject({
        ok: true,
        detail: "Updated to aaaaaaa.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
