// Copies the engine's source files into public/engine/*.txt so the admin
// "Under the hood" view can show them. Runs automatically before `wrangler dev`
// and `wrangler deploy` (see "build" in wrangler.jsonc). The Worker refuses to
// serve /engine/* to anyone without the admin token.
import { mkdirSync, copyFileSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// --- version stamp: VERSION file (you bump it) + build time + git commit ------
// Written to public/version.json, shown in the page footer and at /health.
let version = "0.0.0"; try { version = readFileSync("VERSION", "utf8").trim(); } catch {}
let commit = ""; try { commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
const stamp = { version, builtAt: new Date().toISOString(), commit };
writeFileSync("public/version.json", JSON.stringify(stamp));
console.log(`version ${version} (${commit || "no git"}) built ${stamp.builtAt}`);
const files = ["config.js", "src/index.js", "src/prompt.js", "src/modes.js", "src/firewall.js", "src/gateway.js", "projects/index.js", "wrangler.jsonc", "public/index.html", "public/widget.js", "tests/break-it.mjs"];
mkdirSync("public/engine", { recursive: true });
for (const f of readdirSync("public/engine")) if (f.endsWith(".txt") || f === "index.json") { try { (await import("node:fs")).unlinkSync(join("public/engine", f)); } catch {} }
for (const f of files) copyFileSync(f, join("public/engine", f.replace(/\//g, "__") + ".txt"));
writeFileSync("public/engine/index.json", JSON.stringify(files));
console.log(`engine snapshot: ${files.length} files → public/engine/`);
