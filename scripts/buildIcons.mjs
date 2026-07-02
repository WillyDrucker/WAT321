import svgtofont from "svgtofont";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

/**
 * Generate `media/fonts/wat321-icons.woff` plus a codepoint map from
 * every SVG in `media/svg/`. Codepoints are assigned sequentially
 * starting at 0xE001 so existing glyphs keep stable ids across
 * re-runs as long as the SVG list is append-only; any rename or
 * reorder shifts the map and requires a package.json refresh.
 *
 * Output:
 *   media/fonts/wat321-icons.woff         - the font
 *   media/fonts/wat321-icons.codepoints.json - { name: "\uE001" } map
 *
 * Used by `npm run icons`. Only the .woff ships in the VSIX; the
 * codepoint JSON stays as a source-of-truth for package.json
 * contributes.icons entries.
 */

const projectRoot = process.cwd();
const src = join(projectRoot, "media", "svg");
const dist = join(projectRoot, "media", "fonts");
const fontName = "wat321-icons";

await svgtofont({
  src,
  dist,
  fontName,
  emptyDist: true,
  generateInfoData: false,
  outSVGReact: false,
  outSVGReactNative: false,
  outSVGPath: false,
  website: null,
  css: false,
  typescript: false,
  classNamePrefix: "wat321",
  startUnicode: 0xe001,
  svgicons2svgfont: {
    fontHeight: 1000,
    normalize: true,
    centerHorizontally: true,
  },
});

// svgtofont doesn't emit a standalone codepoint map, so parse the
// generated SVG font's glyph definitions to derive name->codepoint.
// Each glyph in the SVG looks like:
//   <glyph glyph-name="handshake" unicode="&#xE001;" ...>
const svgFontPath = join(dist, `${fontName}.svg`);
if (existsSync(svgFontPath)) {
  const svgFont = readFileSync(svgFontPath, "utf8");
  const codepoints = {};
  const pattern = /<glyph[^>]*glyph-name="([^"]+)"[^>]*unicode="&#x([0-9A-Fa-f]+);"/g;
  for (const match of svgFont.matchAll(pattern)) {
    codepoints[match[1]] = match[2].toUpperCase();
  }
  writeFileSync(
    join(dist, `${fontName}.codepoints.json`),
    `${JSON.stringify(codepoints, null, 2)}\n`,
    "utf8"
  );
  console.log("codepoints:", codepoints);
}
