import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import { BOOKMARKLET_FILE } from "./src/stepUpBridge.js";

const root = fileURLToPath(new URL("./", import.meta.url));
const entry = fileURLToPath(new URL("./src/agent/main.ts", import.meta.url));

/** The agent (src/agent) bundled into one self-contained classic script, which is what the bookmark loads. */
export async function bundleAgent(): Promise<string> {
  const out = await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: { write: false, minify: false, target: "es2022", lib: { entry, formats: ["iife"], name: "StepUpHelperAgent", fileName: "agent" } },
  });
  const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => ("output" in o ? o.output : []));
  const chunk = outputs.find((o) => o.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("The StepUp agent did not build.");
  return chunk.code;
}

/**
 * Serves the agent as `stepup-bookmarklet.js` next to the app, in the build and in the dev server, so the small bookmark
 * people keep loads the current version each time it is clicked.
 */
export function bookmarkletAsset(): Plugin {
  return {
    name: "stepup-bookmarklet",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!(req.url ?? "").split("?")[0]!.endsWith(`/${BOOKMARKLET_FILE}`)) return next();
        try {
          const code = await bundleAgent();
          res.setHeader("content-type", "application/javascript; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(code);
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: BOOKMARKLET_FILE, source: await bundleAgent() });
    },
  };
}
