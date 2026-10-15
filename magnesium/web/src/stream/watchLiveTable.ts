import type { LiveTableItem, StreamSubscribeInput } from "@magnesium/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { connectMagnesium, type MagnesiumRpcClient } from "../rpc.ts";
import {
  applyLiveTableItem,
  emptyLiveTable,
  type LiveTableState,
  resumeFrom,
} from "./liveTable.ts";

/**
 * - `connecting`: until the hub first answers.
 * - `live`: the rows are current.
 * - `reconnecting`: the socket dropped. The rows are kept only to resume
 *   from; they may be stale, so they are not shown as current.
 */
export type HubConnection = "connecting" | "live" | "reconnecting";

export interface LiveTableView<Row> {
  readonly table: LiveTableState<Row>;
  readonly connection: HubConnection;
}

export const initialLiveTableView = <Row>(): LiveTableView<Row> => ({
  table: emptyLiveTable(),
  connection: "connecting",
});

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

/**
 * Follows one live table on the hub's route at `socketUrl` until disposed. It
 * resumes from the last sequence after a drop, retrying with backoff. Each
 * new view is a new object; one that changes nothing is not reported.
 */
export function watchLiveTable<Row, E>(options: {
  readonly socketUrl: string;
  readonly subscribe: (
    client: MagnesiumRpcClient,
    input: StreamSubscribeInput,
  ) => Stream.Stream<LiveTableItem<Row>, E>;
  readonly key: (row: Row) => string;
  readonly onView: (view: LiveTableView<Row>) => void;
}): { readonly dispose: () => void } {
  let view = initialLiveTableView<Row>();
  const update = (next: LiveTableView<Row>) => {
    if (next === view) return;
    view = next;
    options.onView(view);
  };

  const session = Effect.gen(function* () {
    const client = yield* connectMagnesium(options.socketUrl);
    yield* options.subscribe(client, resumeFrom(view.table)).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          const table = applyLiveTableItem(view.table, item, options.key);
          if (table !== view.table || view.connection !== "live") {
            update({ table, connection: "live" });
          }
        }),
      ),
    );
  }).pipe(Effect.scoped);

  const loop = Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      const wasLive = view.connection === "live";
      yield* session.pipe(Effect.exit);
      // A session that got going starts the backoff over.
      attempt = view.connection === "live" && !wasLive ? 1 : attempt + 1;
      if (view.connection !== "reconnecting") update({ ...view, connection: "reconnecting" });
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** (attempt - 1));
      yield* Effect.sleep(Duration.millis(wait));
    }
  });

  const fiber = Effect.runFork(loop);
  return { dispose: () => void Effect.runFork(Fiber.interrupt(fiber)) };
}
