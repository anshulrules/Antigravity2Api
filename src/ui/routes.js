const fs = require("fs/promises");
const path = require("path");

const UI_DIR = __dirname;
const VERSION_CACHE_TTL_MS = 10 * 60 * 1000;

let cachedPackageJson = null;
let versionCache = { ts: 0, payload: null };

function getUpdateRepo() {
  const raw = process.env.AG2API_UPDATE_REPO;
  const repo = typeof raw === "string" ? raw.trim() : "";
  return repo || "znlsl/Antigravity2Api";
}

async function getLocalPackageJson() {
  if (cachedPackageJson) return cachedPackageJson;
  try {
    const candidates = [
      path.resolve(process.cwd(), "package.json"),
      path.resolve(__dirname, "..", "..", "package.json"),
    ];
    for (const pkgPath of candidates) {
      try {
        const text = await fs.readFile(pkgPath, "utf8");
        cachedPackageJson = JSON.parse(text);
        break;
      } catch (_) {}
    }
    if (!cachedPackageJson) cachedPackageJson = {};
  } catch (_) {
    cachedPackageJson = {};
  }
  return cachedPackageJson;
}

async function fetchLatestGithubRelease(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  const res = await fetch(url, {
    signal: controller.signal,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Antigravity2Api",
    },
  }).finally(() => clearTimeout(timer));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status}: ${text || res.statusText || "Request failed"}`);
  }
  const json = await res.json();
  return {
    tag_name: json?.tag_name || null,
    name: json?.name || null,
    html_url: json?.html_url || null,
    published_at: json?.published_at || null,
  };
}

async function getVersionPayload() {
  const now = Date.now();
  if (versionCache.payload && now - versionCache.ts < VERSION_CACHE_TTL_MS) {
    return versionCache.payload;
  }

  const pkg = await getLocalPackageJson();
  const repo = getUpdateRepo();

  let latest = null;
  let error = null;
  try {
    latest = await fetchLatestGithubRelease(repo);
  } catch (e) {
    error = e?.message || String(e);
  }

  const payload = {
    local: {
      name: typeof pkg?.name === "string" ? pkg.name : null,
      version: typeof pkg?.version === "string" ? pkg.version : null,
    },
    latest,
    repo,
    checked_at: new Date(now).toISOString(),
    error,
  };

  versionCache = { ts: now, payload };
  return payload;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function resolveUiFile(relativePath) {
  const safeRel = relativePath.replace(/^\/+/, "");
  const fullPath = path.resolve(UI_DIR, safeRel);
  if (!fullPath.startsWith(path.resolve(UI_DIR) + path.sep)) {
    return null;
  }
  return fullPath;
}

async function serveFile(filePath) {
  const data = await fs.readFile(filePath);
  return {
    status: 200,
    headers: { "Content-Type": contentTypeFor(filePath), "Cache-Control": "no-store" },
    body: data,
  };
}

async function handleUiRoute(req, parsedUrl) {
  const pathname = parsedUrl.pathname;

  if (pathname === "/favicon.ico") {
    return { status: 204, headers: {}, body: "" };
  }

  if (pathname === "/ui/version" && req.method === "GET") {
    const payload = await getVersionPayload();
    return {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify(payload),
    };
  }

  if ((pathname === "/" || pathname === "/ui" || pathname === "/ui/") && req.method === "GET") {
    return serveFile(resolveUiFile("index.html"));
  }

  if (pathname.startsWith("/ui/") && req.method === "GET") {
    const rel = pathname.slice("/ui/".length);
    const fullPath = resolveUiFile(rel);
    if (!fullPath) {
      return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Not Found" };
    }
    try {
      return await serveFile(fullPath);
    } catch (e) {
      return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Not Found" };
    }
  }

  return null;
}

module.exports = {
  handleUiRoute,
};
