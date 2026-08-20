/**
 * Local foreground HTTP board. Bind 127.0.0.1 only. Exits on SIGINT.
 * Not a resident daemon. Not a mux. Not flow.
 */
import http from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  boardState,
  DEFAULT_HOST,
  DEFAULT_PORT,
  findProjectRoot,
  isCardId,
  normalizeCardId,
  resolveFlowBin,
  runCheck,
  waveState,
} from "./lib/flow.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  res.writeHead(status, {
    "content-length": payload.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2) + "\n", {
    "content-type": "application/json; charset=utf-8",
  });
}

function safeWebFile(urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const abs = resolve(WEB_ROOT, decoded);
  const root = WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep;
  if (abs !== WEB_ROOT && !abs.startsWith(root)) return null;
  if (abs.split(sep).includes("..")) return null;
  try {
    if (!statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createDeckServer(opts = {}) {
  const host = opts.host || DEFAULT_HOST;
  const port = Number(opts.port ?? DEFAULT_PORT);
  const cwd = opts.cwd || process.cwd();
  const root = opts.root || findProjectRoot(cwd);
  const flowBin = resolveFlowBin(opts.flowBin);

  const handler = async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    const method = req.method || "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/api/board") {
      if (!root) {
        sendJson(res, 404, { error: "no flow project here", cwd });
        return;
      }
      sendJson(res, 200, boardState(root));
      return;
    }

    if (method === "POST" && path.startsWith("/api/check/")) {
      if (!root) {
        sendJson(res, 404, { error: "no flow project here", cwd });
        return;
      }
      const rawId = path.slice("/api/check/".length);
      if (!isCardId(rawId)) {
        sendJson(res, 400, { error: "invalid card id", id: rawId });
        return;
      }
      try {
        await readBody(req);
      } catch {
        sendJson(res, 413, { error: "payload too large" });
        return;
      }
      const result = runCheck(root, normalizeCardId(rawId), flowBin);
      sendJson(res, 200, result);
      return;
    }

    if (method === "GET" && path === "/api/wave") {
      if (!root) {
        sendJson(res, 404, { error: "no flow project here", cwd });
        return;
      }
      sendJson(res, 200, waveState(root, flowBin));
      return;
    }

    if (method === "GET" && (path === "/favicon.ico" || path === "/favicon.svg")) {
      send(res, 204, "");
      return;
    }

    if (method === "GET") {
      const file = safeWebFile(path);
      if (!file) {
        send(res, 404, "not found\n", { "content-type": "text/plain; charset=utf-8" });
        return;
      }
      const ext = extname(file).toLowerCase();
      send(res, 200, readFileSync(file), {
        "content-type": MIME[ext] || "application/octet-stream",
      });
      return;
    }

    send(res, 405, "method not allowed\n", { "content-type": "text/plain; charset=utf-8" });
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: String(err?.message || err) });
      } else {
        res.end();
      }
    });
  });

  return {
    server,
    host,
    port,
    root,
    flowBin,
    url: `http://${host}:${port}`,
    listen() {
      if (host !== "127.0.0.1" && host !== "localhost") {
        return Promise.reject(new Error("flow-deck binds only to 127.0.0.1"));
      }
      return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolveListen(server);
        });
      });
    },
    close() {
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

export async function serveDeck(opts = {}) {
  const deck = createDeckServer(opts);
  await deck.listen();
  const stop = () => {
    deck.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return deck;
}
