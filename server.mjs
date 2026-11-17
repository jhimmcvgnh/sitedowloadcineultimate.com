import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || "";
const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_ORIGIN = "https://nuvio.tv";
const API_CACHE_TTL_MS = 5 * 60 * 1000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
};

const apiCache = new Map();

function mapRequestPath(pathname) {
  let clean = pathname.split("?")[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    return null;
  }

  if (clean === "/" || clean === "") return "index.html";
  if (clean === "/config.js") return "js/config.js";
  if (clean.startsWith("/_next/static/css/")) {
    return path.posix.join("css", clean.slice("/_next/static/css/".length));
  }
  if (clean.startsWith("/_next/static/chunks/app/")) {
    return path.posix.join("js", clean.slice("/_next/static/chunks/app/".length));
  }
  if (clean.startsWith("/_next/static/chunks/")) {
    return path.posix.join("js", clean.slice("/_next/static/chunks/".length));
  }
  if (clean.startsWith("/_next/static/media/")) {
    return path.posix.join("fonts", clean.slice("/_next/static/media/".length));
  }
  if (clean.startsWith("/_next/static/fonts/")) {
    return path.posix.join("fonts", clean.slice("/_next/static/fonts/".length));
  }

  return clean.replace(/^\/+/, "");
}

function resolveSafeFile(relativePath) {
  if (!relativePath) return null;
  const fullPath = path.resolve(ROOT_DIR, relativePath);
  if (fullPath !== ROOT_DIR && !fullPath.startsWith(ROOT_DIR + path.sep)) {
    return null;
  }
  return fullPath;
}

function sendFile(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  if (!stat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const rangeHeader = req.headers.range;

  if (rangeHeader && stat.size > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      let start = match[1] ? Number.parseInt(match[1], 10) : 0;
      let end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
      if (!match[1] && match[2]) {
        start = Math.max(0, stat.size - end);
        end = stat.size - 1;
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

function proxyApi(req, res, requestUrl) {
  if (req.method === "GET") {
    const cached = apiCache.get(requestUrl);
    if (cached && Date.now() - cached.ts < API_CACHE_TTL_MS) {
      res.writeHead(cached.status, {
        "Content-Type": cached.contentType,
        "Content-Length": cached.body.length,
        "Cache-Control": "public, max-age=60",
      });
      res.end(cached.body);
      return;
    }
  }

  const target = new URL(requestUrl, UPSTREAM_ORIGIN);
  const proxyReq = https.request(
    target,
    {
      method: req.method,
      family: 4,
      timeout: 15000,
      headers: {
        Accept: req.headers.accept || "application/json",
        "User-Agent": "Mozilla/5.0",
      },
    },
    (proxyRes) => {
      const chunks = [];
      proxyRes.on("data", (chunk) => chunks.push(chunk));
      proxyRes.on("end", () => {
        const body = Buffer.concat(chunks);
        const contentType = proxyRes.headers["content-type"] || "application/json; charset=utf-8";
        if (req.method === "GET" && proxyRes.statusCode === 200) {
          apiCache.set(requestUrl, {
            status: 200,
            contentType,
            body,
            ts: Date.now(),
          });
        }
        res.writeHead(proxyRes.statusCode || 502, {
          "Content-Type": contentType,
          "Content-Length": body.length,
        });
        res.end(body);
      });
    }
  );

  proxyReq.on("timeout", () => {
    proxyReq.destroy(new Error("Upstream timeout"));
  });

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Upstream unavailable", detail: err.message }));
    }
  });

  if (req.method !== "GET" && req.method !== "HEAD") {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  const pathname = url.split("?")[0];

  if (pathname.startsWith("/api/")) {
    proxyApi(req, res, url);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }

  const mapped = mapRequestPath(pathname);
  const filePath = resolveSafeFile(mapped);
  if (!filePath) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Invalid path");
    return;
  }

  sendFile(req, res, filePath);
});

const onListen = () => {
  const displayHost = HOST || "localhost";
  console.log(`Nuvio site running locally at http://${displayHost}:${PORT} (http://127.0.0.1:${PORT})`);
};

if (HOST) {
  server.listen(PORT, HOST, onListen);
} else {
  server.listen(PORT, onListen);
}
