#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// magnesium: renders the plain "Mg" mark (D17) into the web icon set in
// magnesium/web/assets. The rename script copies them over upstream's icons.
//
//   node scripts/magnesium-icons.ts
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import sharp from "sharp";

const outDir = NodePath.resolve(import.meta.dirname, "../magnesium/web/assets");

const BACKGROUND = "#161616";
const FOREGROUND = "#f5f5f5";

/**
 * The mark: "Mg" on a square, rounded for favicons, full-bleed for app icons.
 * `scale` shrinks the letters about the centre; the maskable icon uses it to
 * keep them inside the safe circle (80% of the width) that launchers crop to.
 */
export function markSvg(options: { readonly rounded: boolean; readonly scale?: number }): string {
  const radius = options.rounded ? 112 : 0;
  const scale = options.scale ?? 1;
  const transform =
    scale === 1 ? "" : ` transform="translate(256 256) scale(${scale}) translate(-256 -256)"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${radius}" fill="${BACKGROUND}"/>
  <text x="256" y="320"${transform} text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="248" font-weight="700" letter-spacing="-6" fill="${FOREGROUND}">Mg</text>
</svg>
`;
}

const png = (svg: string, size: number) =>
  sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toBuffer();

/** An ICO file holding PNG images, which every current browser reads. */
export function icoFromPngs(images: ReadonlyArray<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Array<Buffer> = [];
  let offset = 6 + 16 * images.length;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

if (import.meta.main) {
  NodeFS.mkdirSync(outDir, { recursive: true });
  const rounded = markSvg({ rounded: true });
  const square = markSvg({ rounded: false });
  NodeFS.writeFileSync(NodePath.join(outDir, "mg-mark.svg"), rounded);
  const favicons = await Promise.all(
    [16, 32, 48].map(async (size) => ({ size, data: await png(rounded, size) })),
  );
  NodeFS.writeFileSync(NodePath.join(outDir, "favicon.ico"), icoFromPngs(favicons));
  NodeFS.writeFileSync(NodePath.join(outDir, "favicon-16x16.png"), favicons[0]!.data);
  NodeFS.writeFileSync(NodePath.join(outDir, "favicon-32x32.png"), favicons[1]!.data);
  for (const [name, size] of [
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ] as const) {
    NodeFS.writeFileSync(NodePath.join(outDir, name), await png(square, size));
  }
  const maskable = markSvg({ rounded: false, scale: 0.8 });
  NodeFS.writeFileSync(NodePath.join(outDir, "icon-maskable-512.png"), await png(maskable, 512));
  console.log(`Wrote the Mg icon set to ${outDir}`);
}
