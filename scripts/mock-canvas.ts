#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// magnesium: the mock canvas (D9), from the repository alone. The boards live in
// docs/magnesium/mockups/canvas as `.dc.html` files, with canvas.json laying them
// out, and render with the runtime beside them (support.js).
//
//   node scripts/mock-canvas.ts [--port 4310]       serve the canvas; open the printed URL
//   node scripts/mock-canvas.ts render [Board.dc.html ...] [--theme dark] [--out <dir>]
//
// `render` writes each board (all, or the ones named) to the PNG its canvas.json
// entry names, under docs/magnesium/mockups (or --out), as mockups.md shows them,
// using the Chromium that Playwright has installed for the server's browser tests.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const CANVAS = NodePath.join(ROOT, "docs/magnesium/mockups/canvas");
const MOCKUPS = NodePath.dirname(CANVAS);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

interface Board {
  readonly w: number;
  readonly h: number;
  readonly title?: string;
  readonly png?: string;
}

/** The part of Playwright this uses; it is the server's dependency, not the scripts'. */
interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options: { state: "attached" }): Promise<unknown>;
  waitForLoadState(state: "networkidle"): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: {
    path: string;
    clip: { x: number; y: number; width: number; height: number };
  }): Promise<unknown>;
  close(): Promise<void>;
}
interface Chromium {
  launch(): Promise<{
    newPage(options: {
      viewport: { width: number; height: number };
      deviceScaleFactor: number;
    }): Promise<Page>;
    close(): Promise<void>;
  }>;
}

const readIndex = () =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(CANVAS, "canvas.json"), "utf8")) as {
    readonly boards: Record<string, Board>;
    readonly order: ReadonlyArray<string>;
  };

const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};

/** Serves the canvas folder, read-only, on 127.0.0.1. */
const serve = (port: number) =>
  new Promise<NodeHttp.Server>((resolve) => {
    const server = NodeHttp.createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
      const file = NodePath.join(CANVAS, path === "/" ? "index.html" : path);
      if (!file.startsWith(CANVAS + NodePath.sep) || !NodeFS.existsSync(file)) {
        response.writeHead(404).end("Not found");
        return;
      }
      const type = TYPES[NodePath.extname(file)] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      NodeFS.createReadStream(file).pipe(response);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

const render = async (names: ReadonlyArray<string>, theme: string, outDir: string) => {
  // Playwright comes with the server's browser tests; this borrows it from there.
  const require = NodeModule.createRequire(NodePath.join(ROOT, "apps/server/package.json"));
  const { chromium } = require("playwright-core") as { chromium: Chromium };
  const index = readIndex();
  const files = names.length > 0 ? names : index.order;
  const server = await serve(0);
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const browser = await chromium.launch();
  try {
    for (const file of files) {
      const board = index.boards[file];
      if (!board?.png) throw new Error(`${file} has no "png" in canvas.json`);
      // Phone boards are kept at twice their size, like a phone's screen.
      const page = await browser.newPage({
        viewport: { width: board.w, height: board.h },
        deviceScaleFactor: board.w < 600 ? 2 : 1,
      });
      await page.goto(`${origin}/${file}${theme === "dark" ? "?theme=dark" : ""}`);
      await page.waitForSelector("html[data-dc-ready]", { state: "attached" });
      await page.waitForLoadState("networkidle");
      await page.evaluate("document.fonts.ready");
      const out = NodePath.join(
        outDir,
        theme === "dark" ? board.png.replace(/\.png$/, "-dark.png") : board.png,
      );
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: board.w, height: board.h } });
      await page.close();
      console.log(`${file} → ${NodePath.relative(ROOT, out)}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
};

if (process.argv[2] === "render") {
  const names: string[] = [];
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i]!.startsWith("--")) i++;
    else names.push(process.argv[i]!);
  }
  await render(names, flag("--theme") ?? "light", NodePath.resolve(flag("--out") ?? MOCKUPS));
} else {
  const server = await serve(Number(flag("--port") ?? 4310));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  console.log(`Mock canvas: http://127.0.0.1:${port}/`);
}
