import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import { startServer } from "../view/server.ts";
import { withErrors } from "../util/cli.ts";
import { loadConfig } from "../config.ts";

export const viewCmd = defineCommand({
  meta: {
    name: "view",
    description: "Open a local web UI for browsing memories (also serves the chat panel)",
  },
  args: {
    port: { type: "string", description: "Port to listen on", default: "5556" },
    bind: { type: "string", description: "Address to bind (default 127.0.0.1; use 0.0.0.0 to expose)", default: "127.0.0.1" },
    token: { type: "string", description: "Bearer token to require on /api (else uses KEN_TOKEN env or config)", default: "" },
    "no-open": { type: "boolean", description: "Don't auto-open the browser", default: false },
  },
  run: withErrors(async (args) => {
    const cfg = loadConfig();
    const port = parseInt(args.port as string, 10) || 5556;
    const bind = (args.bind as string) || "127.0.0.1";
    const token = (args.token as string) || cfg.server.token || "";
    const handle = startServer({ port, bind, token });
    process.stdout.write(`ken view → ${handle.url}\n`);
    if (token) process.stdout.write(`(auth: bearer token required)\n`);
    if (bind !== "127.0.0.1" && bind !== "localhost" && !token) {
      process.stderr.write(`WARNING: bound to ${bind} with no auth token. Anyone on the network can read/write your memories.\n`);
    }
    process.stdout.write(`(Ctrl-C to stop)\n`);
    if (!args["no-open"] && (bind === "127.0.0.1" || bind === "localhost")) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [handle.url], { stdio: "ignore", detached: true }).unref();
    }
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        process.stdout.write("\nstopping…\n");
        handle.stop();
        resolve();
      });
    });
  }),
});
