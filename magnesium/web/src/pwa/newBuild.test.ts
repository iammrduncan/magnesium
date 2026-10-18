import { describe, expect, it } from "@effect/vitest";

import { entryScriptOf } from "./newBuild.ts";

describe("entryScriptOf", () => {
  it("names the build's entry script, past the inline boot script", () => {
    const html = [
      "<!doctype html><html><head>",
      "<script>(() => { document.documentElement.dataset.theme = 'dark'; })();</script>",
      '<link rel="modulepreload" crossorigin href="/assets/vendor-Q1w2E3r4.js">',
      '<script type="module" crossorigin src="/assets/index-vV1F_Qv6.js"></script>',
      "</head><body><div id=root></div></body></html>",
    ].join("\n");
    expect(entryScriptOf(html)).toBe("/assets/index-vV1F_Qv6.js");
  });

  it("finds nothing in a page that isn't the app, so it never reads as a new build", () => {
    expect(entryScriptOf("<html><body><h1>502 Bad Gateway</h1></body></html>")).toBeNull();
    expect(entryScriptOf("")).toBeNull();
  });
});
