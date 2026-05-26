const http = require("http");
const https = require("https");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { URL } = require("url");

const APP_ROOT = __dirname;
const PUBLIC_DIR = path.join(APP_ROOT, "public");
const DATA_DIR = path.join(APP_ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const REPOSITORY_DIR = path.join(DATA_DIR, "repositories");
const UPLOADS_INDEX = path.join(DATA_DIR, "uploads.json");
const CONFIG_PATH = path.join(APP_ROOT, "config.json");
const CONFIG_EXAMPLE_PATH = path.join(APP_ROOT, "config.example.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const uploads = new Map();
const jobs = new Map();
const authState = {
  jira: { ok: false, checkedAt: null, message: "Не проверено" },
  confluence: { ok: false, checkedAt: null, message: "Не проверено" }
};

let config = {};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  await ensureDirectories();
  config = await loadConfig();
  await loadUploads();

  const host = config.host || "127.0.0.1";
  const port = Number(process.env.PORT || config.port || 5178);
  const server = http.createServer(routeRequest);

  server.listen(port, host, () => {
    console.log(`Analytics CLI Orchestrator: http://${host}:${port}`);
  });
}

async function ensureDirectories() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(REPOSITORY_DIR, { recursive: true });
}

async function loadConfig() {
  const defaults = JSON.parse(await fsp.readFile(CONFIG_EXAMPLE_PATH, "utf8"));
  let userConfig = {};

  try {
    userConfig = JSON.parse(await fsp.readFile(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Не удалось прочитать config.json: ${error.message}`);
    }
  }

  return deepMerge(defaults, userConfig);
}

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : override;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(base ? base[key] : undefined, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function loadUploads() {
  try {
    const records = JSON.parse(await fsp.readFile(UPLOADS_INDEX, "utf8"));
    for (const record of records) {
      if (!record.id || !record.storagePath) {
        continue;
      }
      try {
        await fsp.access(record.storagePath);
        uploads.set(record.id, record);
      } catch {
        // Ignore stale upload records.
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Не удалось прочитать индекс загруженных файлов: ${error.message}`);
    }
  }
}

async function saveUploads() {
  await fsp.writeFile(UPLOADS_INDEX, JSON.stringify([...uploads.values()], null, 2), "utf8");
}

async function routeRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (requestUrl.pathname === "/" && req.method === "GET") {
      await serveFile(res, path.join(PUBLIC_DIR, "index.html"));
      return;
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      await routeApi(req, res, requestUrl);
      return;
    }

    await serveStatic(req, res, requestUrl.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, {
        error: error.publicMessage || error.message || "Внутренняя ошибка сервера"
      });
    } else {
      res.end();
    }
  }
}

async function routeApi(req, res, requestUrl) {
  if (req.method === "GET" && requestUrl.pathname === "/api/config") {
    sendJson(res, 200, getPublicConfig());
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/uploads") {
    sendJson(res, 200, { files: [...uploads.values()].map(toPublicUpload) });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/uploads") {
    const files = await handleUpload(req);
    sendJson(res, 200, { files: files.map(toPublicUpload) });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/repository-folders") {
    const repository = await handleRepositoryFolderUpload(req);
    sendJson(res, 200, repository);
    return;
  }

  const uploadDeleteMatch = requestUrl.pathname.match(/^\/api\/uploads\/([^/]+)$/);
  if (req.method === "DELETE" && uploadDeleteMatch) {
    await deleteUpload(uploadDeleteMatch[1]);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/pick-directory") {
    const selectedPath = await pickDirectory();
    sendJson(res, 200, { path: selectedPath });
    return;
  }

  const authMatch = requestUrl.pathname.match(/^\/api\/auth\/(jira|confluence)$/);
  if (req.method === "POST" && authMatch) {
    const state = await authenticate(authMatch[1]);
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs") {
    const payload = await readJson(req);
    if (!hasAnyInput(payload)) {
      sendJson(res, 400, { error: "Добавьте хотя бы один источник данных для аналитики." });
      return;
    }

    const job = createJob(getConfiguredCliName());
    sendJson(res, 202, { jobId: job.id });
    runJob(job, payload).catch((error) => failJob(job, error));
    return;
  }

  const eventsMatch = requestUrl.pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    streamJobEvents(req, res, eventsMatch[1]);
    return;
  }

  const inputMatch = requestUrl.pathname.match(/^\/api\/jobs\/([^/]+)\/input$/);
  if (req.method === "POST" && inputMatch) {
    const body = await readJson(req);
    sendInputToJob(inputMatch[1], body.text || "");
    sendJson(res, 200, { ok: true });
    return;
  }

  const stopMatch = requestUrl.pathname.match(/^\/api\/jobs\/([^/]+)\/stop$/);
  if (req.method === "POST" && stopMatch) {
    stopJob(stopMatch[1]);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "API endpoint не найден." });
}

function getPublicConfig() {
  const sddCapabilities = getSddCapabilities();
  const activeCliName = getConfiguredCliName();
  const activeCliConfig = getConfiguredCliConfig();
  return {
    host: config.host,
    port: config.port,
    outputDirectory: resolveAppPath(config.outputDirectory || "analytics-output"),
    service: {
      mode: getRepositoryMode(),
      defaultBranch: getDefaultRepositoryBranch()
    },
    sdd: {
      defaultProfile: normalizeSddProfile(config.sdd?.defaultProfile),
      profiles: getSddProfiles(),
      capabilities: sddCapabilities
    },
    cli: {
      active: activeCliName,
      default: activeCliName,
      options: Object.keys(config.cli?.commands || {}),
      configured: Boolean(activeCliConfig),
      command: activeCliConfig?.command || "",
      cwd: activeCliConfig?.cwd || "."
    },
    integrations: {
      jira: {
        configured: Boolean(config.integrations?.jira?.baseUrl || getBrowserAuthUrl(config.integrations?.jira)),
        baseUrl: config.integrations?.jira?.baseUrl || "",
        authMode: getIntegrationAuthMode("jira", config.integrations?.jira),
        browserAuthUrl: getBrowserAuthUrl(config.integrations?.jira),
        auth: authState.jira
      },
      confluence: {
        configured: Boolean(config.integrations?.confluence?.baseUrl || getBrowserAuthUrl(config.integrations?.confluence)),
        baseUrl: config.integrations?.confluence?.baseUrl || "",
        authMode: getIntegrationAuthMode("confluence", config.integrations?.confluence),
        browserAuthUrl: getBrowserAuthUrl(config.integrations?.confluence),
        auth: authState.confluence
      }
    }
  };
}

function getConfiguredCliName() {
  return compact(config.cli?.active || config.cli?.default || "codex");
}

function getConfiguredCliConfig() {
  return config.cli?.commands?.[getConfiguredCliName()] || null;
}

function getSddProfiles() {
  const configuredProfiles = Array.isArray(config.sdd?.profiles) ? config.sdd.profiles : [];
  const profiles = configuredProfiles.length ? configuredProfiles : ["markdown", "openspec", "speckit", "hybrid"];
  return profiles
    .map(normalizeSddProfile)
    .filter((value, index, list) => value && list.indexOf(value) === index);
}

function normalizeSddProfile(profile) {
  const value = compact(profile).toLowerCase();
  return ["markdown", "openspec", "speckit", "hybrid"].includes(value) ? value : "markdown";
}

function getSddCapabilities() {
  const openSpecSkills = findSkillNames(["openspec-"]);
  const specKitSkills = findSkillNames(["speckit-"]);
  const openSpecCli = commandFileExists("openspec");
  const specifyCli = commandFileExists("specify");

  return {
    openspec: {
      cli: openSpecCli,
      skills: openSpecSkills,
      available: openSpecCli || openSpecSkills.length > 0
    },
    speckit: {
      cli: specifyCli,
      skills: specKitSkills,
      available: specifyCli || specKitSkills.length > 0
    }
  };
}

function findSkillNames(prefixes) {
  const roots = [
    path.join(APP_ROOT, ".codex", "skills"),
    path.join(APP_ROOT, ".agents", "skills"),
    path.join(os.homedir(), ".codex", "skills"),
    path.join(os.homedir(), ".agents", "skills")
  ];
  const names = new Set();

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (prefixes.some((prefix) => entry.name.startsWith(prefix))) {
        names.add(entry.name);
      }
    }
  }

  return [...names].sort();
}

function commandFileExists(commandName) {
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".ps1", ""] : ["", ".sh"];
  const searchDirs = [
    path.join(APP_ROOT, "npm-global"),
    path.join(APP_ROOT, "tools", "node"),
    ...(process.env.PATH || process.env.Path || "").split(path.delimiter)
  ].filter(Boolean);

  return searchDirs.some((dir) => {
    return extensions.some((extension) => fs.existsSync(path.join(dir, `${commandName}${extension}`)));
  });
}

function getRepositoryMode() {
  return compact(config.service?.mode).toLowerCase() === "global" ? "global" : "local";
}

function getDefaultRepositoryBranch() {
  return compact(config.service?.defaultBranch) || "main";
}

function getRepositoryCheckoutRoot() {
  return resolveAppPath(config.service?.repositoryCheckoutDirectory || "data/repositories");
}

function hasAnyInput(payload) {
  const repos = Array.isArray(payload.repositories) && payload.repositories.some((repo) => {
    return compact(repo.path) || compact(repo.url) || compact(repo.description);
  });
  const files = Array.isArray(payload.files) && payload.files.length > 0;
  const jira = Array.isArray(payload.jiraLinks) && payload.jiraLinks.some(compact);
  const confluence = Array.isArray(payload.confluenceLinks) && payload.confluenceLinks.some(compact);
  const task = Boolean(compact(payload.taskDescription));
  return repos || files || jira || confluence || task;
}

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Метод не поддерживается." });
    return;
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Доступ запрещен." });
    return;
  }

  await serveFile(res, filePath);
}

async function serveFile(res, filePath) {
  try {
    await fsp.access(filePath, fs.constants.R_OK);
    const contentType = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    stream.pipe(res);
    stream.on("error", () => {
      res.end();
    });
  } catch {
    sendJson(res, 404, { error: "Файл не найден." });
  }
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.length) {
    return {};
  }

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    const error = new Error("Некорректный JSON в запросе.");
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  const maxBytes = Number(config.maxRequestBytes || 100 * 1024 * 1024);
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Запрос слишком большой.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function handleUpload(req) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error("Не найден multipart boundary.");
    error.statusCode = 400;
    throw error;
  }

  const body = await readBody(req);
  const parts = parseMultipart(body, boundaryMatch[1] || boundaryMatch[2]);
  const savedFiles = [];

  for (const part of parts) {
    if (!part.filename || !part.content.length) {
      continue;
    }

    const id = crypto.randomUUID();
    const originalName = sanitizeFileName(part.filename);
    const storageName = `${id}-${originalName}`;
    const storagePath = path.join(UPLOAD_DIR, storageName);
    await fsp.writeFile(storagePath, part.content);

    const record = {
      id,
      originalName,
      mimeType: part.contentType || "application/octet-stream",
      size: part.content.length,
      storagePath,
      uploadedAt: new Date().toISOString()
    };
    uploads.set(id, record);
    savedFiles.push(record);
  }

  await saveUploads();
  return savedFiles;
}

async function handleRepositoryFolderUpload(req) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error("Не найден multipart boundary.");
    error.statusCode = 400;
    throw error;
  }

  const body = await readBody(req);
  const parts = parseMultipart(body, boundaryMatch[1] || boundaryMatch[2])
    .filter((part) => part.name === "files" && part.filename);

  if (!parts.length) {
    const error = new Error("В выбранной папке не найдено файлов для загрузки.");
    error.statusCode = 400;
    throw error;
  }

  const relativePaths = parts.map((part) => splitUploadPath(part.filename));
  const commonRoot = findCommonUploadRoot(relativePaths);
  const folderLabel = commonRoot || "repository";
  const targetRoot = path.join(REPOSITORY_DIR, `${crypto.randomUUID()}-${sanitizeFileName(folderLabel)}`);
  await fsp.mkdir(targetRoot, { recursive: true });

  let totalSize = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const relativePath = sanitizeRelativeUploadPath(relativePaths[index], commonRoot);
    const targetPath = path.resolve(targetRoot, relativePath);

    if (!isPathInside(targetRoot, targetPath)) {
      const error = new Error(`Небезопасный путь внутри выбранной папки: ${part.filename}`);
      error.statusCode = 400;
      throw error;
    }

    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, part.content);
    totalSize += part.content.length;
  }

  return {
    path: targetRoot,
    folderName: folderLabel,
    fileCount: parts.length,
    size: totalSize
  };
}

function splitUploadPath(uploadPath) {
  return String(uploadPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function findCommonUploadRoot(paths) {
  const firstRoot = paths[0]?.[0] || "";
  if (!firstRoot) {
    return "";
  }
  return paths.every((segments) => segments.length > 1 && segments[0] === firstRoot) ? firstRoot : "";
}

function sanitizeRelativeUploadPath(segments, commonRoot) {
  const effectiveSegments = commonRoot ? segments.slice(1) : segments;
  const safeSegments = effectiveSegments
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map(sanitizePathSegment);

  if (!safeSegments.length) {
    return sanitizePathSegment(segments.at(-1) || "file");
  }

  return path.join(...safeSegments);
}

function sanitizePathSegment(segment) {
  const safeSegment = String(segment)
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  const value = safeSegment || "file";
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  return reserved.test(value) ? `${value}_` : value;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseMultipart(body, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const separator = Buffer.from("\r\n\r\n");
  const parts = [];
  let cursor = 0;

  while (cursor < body.length) {
    const boundaryStart = body.indexOf(boundaryBuffer, cursor);
    if (boundaryStart === -1) {
      break;
    }

    let partStart = boundaryStart + boundaryBuffer.length;
    if (body.slice(partStart, partStart + 2).toString() === "--") {
      break;
    }
    if (body.slice(partStart, partStart + 2).toString() === "\r\n") {
      partStart += 2;
    }

    const headerEnd = body.indexOf(separator, partStart);
    if (headerEnd === -1) {
      break;
    }

    const dataStart = headerEnd + separator.length;
    const nextBoundary = body.indexOf(boundaryBuffer, dataStart);
    if (nextBoundary === -1) {
      break;
    }

    let dataEnd = nextBoundary;
    if (body.slice(dataEnd - 2, dataEnd).toString() === "\r\n") {
      dataEnd -= 2;
    }

    const headers = parsePartHeaders(body.slice(partStart, headerEnd).toString("utf8"));
    parts.push({
      name: headers.name,
      filename: headers.filename,
      contentType: headers.contentType,
      content: body.slice(dataStart, dataEnd)
    });
    cursor = nextBoundary;
  }

  return parts;
}

function parsePartHeaders(rawHeaders) {
  const headers = {};
  for (const line of rawHeaders.split(/\r?\n/)) {
    const [name, ...rest] = line.split(":");
    if (!name || !rest.length) {
      continue;
    }
    headers[name.toLowerCase()] = rest.join(":").trim();
  }

  const disposition = headers["content-disposition"] || "";
  const name = /name="([^"]*)"/.exec(disposition)?.[1] || "";
  const filename = /filename="([^"]*)"/.exec(disposition)?.[1] || "";

  return {
    name,
    filename,
    contentType: headers["content-type"] || ""
  };
}

function sanitizeFileName(fileName) {
  return path.basename(fileName).replace(/[^\wа-яА-ЯёЁ.\- ()[\]]+/g, "_") || "file";
}

function toPublicUpload(record) {
  return {
    id: record.id,
    originalName: record.originalName,
    mimeType: record.mimeType,
    size: record.size,
    uploadedAt: record.uploadedAt
  };
}

async function deleteUpload(id) {
  const record = uploads.get(id);
  if (!record) {
    const error = new Error("Файл не найден.");
    error.statusCode = 404;
    throw error;
  }

  uploads.delete(id);
  await fsp.rm(record.storagePath, { force: true });
  await saveUploads();
}

async function pickDirectory() {
  if (process.platform === "win32") {
    return pickDirectoryWindows();
  }
  return pickDirectoryLinux();
}

async function pickDirectoryWindows() {
  const scriptPath = path.join(APP_ROOT, "scripts", "pick-directory-win.ps1");
  return runPicker("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath
  ]);
}

async function pickDirectoryLinux() {
  const candidates = [
    { command: "zenity", args: ["--file-selection", "--directory", "--title=Выберите путь к репозиторию"] },
    { command: "kdialog", args: ["--getexistingdirectory", os.homedir()] }
  ];

  for (const candidate of candidates) {
    if (!(await commandExists(candidate.command))) {
      continue;
    }
    return runPicker(candidate.command, candidate.args);
  }

  const error = new Error("Не найден zenity или kdialog. Введите путь вручную.");
  error.statusCode = 501;
  throw error;
}

async function commandExists(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    await runProcess(checker, [command], { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function runPicker(command, args) {
  const result = await runProcess(command, args, { timeoutMs: Number(config.service?.directoryPickerTimeoutMs || 2 * 60 * 1000) });
  const selectedPath = result.stdout.trim();
  if (!selectedPath) {
    const error = new Error("Выбор пути отменен.");
    error.statusCode = 400;
    throw error;
  }
  return selectedPath;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: options.windowsHide === undefined ? false : Boolean(options.windowsHide),
      shell: options.shell === undefined ? false : Boolean(options.shell)
    });
    let stdout = "";
    let stderr = "";
    let timer = null;

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Команда ${command} превысила таймаут.`));
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `Команда ${command} завершилась с кодом ${code}.`));
      }
    });
  });
}

async function authenticate(service) {
  const integration = config.integrations?.[service];
  const browserAuthUrl = getBrowserAuthUrl(integration);
  const authMode = getIntegrationAuthMode(service, integration);

  if (authMode === "browser") {
    if (!browserAuthUrl) {
      const state = {
        ok: false,
        checkedAt: new Date().toISOString(),
        message: `URL браузерной аутентификации для ${service} не задан в config.json.`
      };
      authState[service] = state;
      return state;
    }

    const state = {
      ok: false,
      status: "opened",
      checkedAt: new Date().toISOString(),
      message: "Стартовая страница аутентификации открыта. Система сама сгенерирует OIDC state/nonce; выберите сертификат в системном диалоге и завершите вход в браузере."
    };
    authState[service] = state;
    return state;
  }

  if (!integration?.baseUrl) {
    const state = {
      ok: false,
      checkedAt: new Date().toISOString(),
      message: `URL для ${service} не задан в config.json.`
    };
    authState[service] = state;
    return state;
  }

  const authUrl = new URL(integration.authCheckPath || "/", normalizeBaseUrl(integration.baseUrl)).toString();
  try {
    await requestUrl(authUrl, {
      integration,
      responseType: "text",
      maxBytes: 5 * 1024 * 1024
    });
    const state = {
      ok: true,
      checkedAt: new Date().toISOString(),
      message: "Аутентификация по сертификату успешна."
    };
    authState[service] = state;
    return state;
  } catch (error) {
    const state = {
      ok: false,
      checkedAt: new Date().toISOString(),
      message: error.message
    };
    authState[service] = state;
    return state;
  }
}

function getIntegrationAuthMode(service, integration) {
  const configuredMode = compact(integration?.authMode).toLowerCase();
  if (configuredMode) {
    return configuredMode;
  }
  if ((service === "jira" || service === "confluence") && getBrowserAuthUrl(integration)) {
    return "browser";
  }
  return "certificate";
}

function getBrowserAuthUrl(integration) {
  const configuredUrl = compact(integration?.browserAuthUrl || integration?.authUrl);
  const stableUrl = getStableAuthEntryUrl(configuredUrl);
  if (stableUrl) {
    return stableUrl;
  }

  if (integration?.baseUrl) {
    return new URL(compact(integration.browserAuthPath || integration.authStartPath || "/"), normalizeBaseUrl(integration.baseUrl)).toString();
  }

  return configuredUrl;
}

function getStableAuthEntryUrl(configuredUrl) {
  if (!configuredUrl) {
    return "";
  }

  try {
    const url = new URL(configuredUrl);
    const redirectUri = url.searchParams.get("redirect_uri");
    const hasDynamicOidcState = url.searchParams.has("state") || url.searchParams.has("nonce");
    if (redirectUri && hasDynamicOidcState) {
      const redirectUrl = new URL(redirectUri);
      return new URL("/", redirectUrl.origin).toString();
    }
  } catch {
    return "";
  }

  return configuredUrl;
}

async function runJob(job, payload) {
  job.status = "running";
  emitJob(job, "status", { status: "running", message: "Обработка запущена." });

  const cliName = getConfiguredCliName();
  const outputProfile = normalizeSddProfile(payload.outputProfile || config.sdd?.defaultProfile);
  const outputRoot = resolveAppPath(config.outputDirectory || "analytics-output");
  const outputDir = path.join(outputRoot, job.id);
  await fsp.mkdir(outputDir, { recursive: true });

  const stepResults = [];
  let repositories = normalizeRepositories(payload.repositories);
  const jiraLinks = normalizeStringList(payload.jiraLinks);
  const confluenceLinks = normalizeStringList(payload.confluenceLinks);
  const fileIds = normalizeStringList(payload.files);
  const taskDescription = compact(payload.taskDescription);
  repositories = await prepareRepositoriesForJob(job, repositories);

  emitJob(job, "log", {
    message: `CLI: ${cliName}. SDD-профиль: ${outputProfile}. Каталог результата: ${outputDir}`
  });

  const sourceIndexPath = await writeSourceIndex(outputDir, {
    cliName,
    outputProfile,
    repositories,
    jiraLinks,
    confluenceLinks,
    fileIds,
    taskDescription
  });

  if (repositories.length) {
    const prompt = buildRepositoryPrompt(repositories);
    const output = await runCliStep(job, cliName, "Исходные репозитории", prompt);
    stepResults.push({ title: "Исходные репозитории", input: prompt, output });
  }

  if (jiraLinks.length) {
    const jiraContext = await collectJiraContext(job, jiraLinks);
    const prompt = buildJiraPrompt(jiraContext);
    const output = await runCliStep(job, cliName, "Jira задачи", prompt);
    stepResults.push({ title: "Jira задачи", input: prompt, output });
  }

  if (fileIds.length) {
    const filesContext = await collectUploadedFilesContext(fileIds);
    const prompt = buildFilesPrompt(filesContext);
    const output = await runCliStep(job, cliName, "Файлы системной аналитики", prompt);
    stepResults.push({ title: "Файлы системной аналитики", input: prompt, output });
  }

  if (confluenceLinks.length) {
    const confluenceContext = await collectConfluenceContext(job, confluenceLinks);
    const prompt = buildConfluencePrompt(confluenceContext);
    const output = await runCliStep(job, cliName, "Confluence страницы", prompt);
    stepResults.push({ title: "Confluence страницы", input: prompt, output });
  }

  if (taskDescription) {
    const prompt = buildTaskDescriptionPrompt(taskDescription);
    const output = await runCliStep(job, cliName, "Свободное описание задачи", prompt);
    stepResults.push({ title: "Свободное описание задачи", input: prompt, output });
  }

  const finalPrompt = buildFinalPrompt(stepResults, outputDir, {
    cliName,
    outputProfile,
    sourceIndexPath,
    capabilities: getSddCapabilities()
  });
  const finalOutput = await runCliStep(job, cliName, "Итоговая структура markdown-аналитики", finalPrompt);
  stepResults.push({ title: "Итоговая структура markdown-аналитики", input: finalPrompt, output: finalOutput });

  await writeJobTranscript(outputDir, job, stepResults);

  job.status = "completed";
  emitJob(job, "status", {
    status: "completed",
    message: "Обработка завершена.",
    outputDir
  });
  closeJobClients(job);
}

async function writeSourceIndex(outputDir, data) {
  const fileRecords = data.fileIds.map((id) => {
    const upload = uploads.get(id);
    if (!upload) {
      return { id, missing: true };
    }
    return {
      id,
      name: upload.originalName,
      mimeType: upload.mimeType,
      size: upload.size,
      path: upload.storagePath,
      uploadedAt: upload.uploadedAt
    };
  });

  const sourceIndex = {
    generatedAt: new Date().toISOString(),
    cli: data.cliName,
    outputProfile: data.outputProfile,
    repositories: data.repositories,
    files: fileRecords,
    jiraLinks: data.jiraLinks,
    confluenceLinks: data.confluenceLinks,
    hasTaskDescription: Boolean(data.taskDescription),
    taskDescriptionPreview: data.taskDescription ? data.taskDescription.slice(0, 500) : ""
  };

  const sourceIndexPath = path.join(outputDir, "source-index.json");
  await fsp.writeFile(sourceIndexPath, JSON.stringify(sourceIndex, null, 2), "utf8");
  return sourceIndexPath;
}

function failJob(job, error) {
  job.status = "failed";
  job.activeChild = null;
  emitJob(job, "error", { message: error.message || "Ошибка обработки." });
  emitJob(job, "status", { status: "failed", message: "Обработка остановлена с ошибкой." });
  closeJobClients(job);
}

function createJob(cliName) {
  const id = `job-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const job = {
    id,
    cliName,
    status: "queued",
    createdAt: new Date().toISOString(),
    events: [],
    clients: new Set(),
    activeChild: null,
    transcript: []
  };
  jobs.set(id, job);
  emitJob(job, "status", { status: "queued", message: "Задача поставлена в очередь." });
  return job;
}

function emitJob(job, type, payload) {
  const event = {
    id: job.events.length + 1,
    type,
    payload,
    timestamp: new Date().toISOString()
  };
  job.events.push(event);
  job.transcript.push(event);

  if (job.events.length > 1000) {
    job.events.splice(0, job.events.length - 1000);
  }

  const serialized = `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
  for (const client of job.clients) {
    client.write(serialized);
  }
}

function streamJobEvents(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    sendJson(res, 404, { error: "Задача не найдена." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });

  for (const event of job.events) {
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  }

  job.clients.add(res);
  req.on("close", () => {
    job.clients.delete(res);
  });
}

function closeJobClients(job) {
  for (const client of job.clients) {
    client.end();
  }
  job.clients.clear();
}

function sendInputToJob(jobId, text) {
  const job = jobs.get(jobId);
  if (!job) {
    const error = new Error("Задача не найдена.");
    error.statusCode = 404;
    throw error;
  }
  if (!job.activeChild || job.activeChild.stdin.destroyed) {
    const error = new Error("Сейчас нет активного CLI-процесса, который принимает ввод.");
    error.statusCode = 409;
    throw error;
  }

  job.activeChild.stdin.write(`${text}\n`);
  emitJob(job, "log", { message: `Пользовательский ввод отправлен в CLI: ${text}` });
}

function stopJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }
  if (job.activeChild) {
    job.activeChild.kill();
  }
  job.status = "stopped";
  emitJob(job, "status", { status: "stopped", message: "Задача остановлена пользователем." });
  closeJobClients(job);
}

async function runCliStep(job, cliName, title, prompt) {
  const cliConfig = config.cli?.commands?.[cliName];
  if (!cliConfig) {
    throw new Error(`CLI "${cliName}" не настроен в config.json.`);
  }

  emitJob(job, "step", { title, status: "started" });

  const command = cliConfig.command;
  const promptMode = cliConfig.promptMode || "stdin";
  const args = [...(cliConfig.args || [])];
  if (promptMode === "argument") {
    args.push(prompt);
  }

  const cwd = resolveAppPath(cliConfig.cwd || ".");
  const env = buildCliEnv(cliConfig.env || {});
  const child = spawn(command, args, {
    cwd,
    env,
    shell: cliConfig.shell === undefined ? process.platform === "win32" : Boolean(cliConfig.shell),
    windowsHide: true
  });

  job.activeChild = child;

  let output = "";
  const appendOutput = (streamName, chunk) => {
    const text = chunk.toString("utf8");
    output += text;
    emitJob(job, "cli-output", { title, stream: streamName, text });
  };

  child.stdout.on("data", (chunk) => appendOutput("stdout", chunk));
  child.stderr.on("data", (chunk) => appendOutput("stderr", chunk));

  const exitPromise = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      job.activeChild = null;
      if (code === 0) {
        emitJob(job, "step", { title, status: "completed" });
        resolve(output);
      } else {
        const error = new Error(`Шаг "${title}" завершился с кодом ${code}.`);
        error.cliOutput = output;
        emitJob(job, "step", { title, status: "failed" });
        reject(error);
      }
    });
  });

  if (promptMode === "stdin") {
    child.stdin.write(prompt);
    child.stdin.write("\n");
    if (cliConfig.closeStdinAfterPrompt !== false) {
      child.stdin.end();
    }
  }

  return exitPromise;
}

function buildCliEnv(extraEnv) {
  const pathEntries = [
    path.join(APP_ROOT, "npm-global"),
    path.join(APP_ROOT, "tools", "node"),
    process.env.PATH || process.env.Path || ""
  ].filter(Boolean);

  return {
    ...process.env,
    PATH: pathEntries.join(path.delimiter),
    Path: pathEntries.join(path.delimiter),
    ...extraEnv
  };
}

function normalizeRepositories(repositories) {
  if (!Array.isArray(repositories)) {
    return [];
  }

  const mode = getRepositoryMode();
  return repositories
    .map((repo) => ({
      mode,
      path: compact(repo.path),
      url: compact(repo.url),
      branch: compact(repo.branch) || getDefaultRepositoryBranch(),
      authType: normalizeRepositoryAuthType(repo.authType),
      username: compact(repo.username),
      password: typeof repo.password === "string" ? repo.password : "",
      sshKey: typeof repo.sshKey === "string" ? repo.sshKey : "",
      description: compact(repo.description),
      kind: compact(repo.kind) || "исходный код"
    }))
    .filter((repo) => repo.path || repo.url || repo.description);
}

function normalizeRepositoryAuthType(value) {
  const authType = compact(value).toLowerCase();
  return ["basic", "ssh"].includes(authType) ? authType : "none";
}

async function prepareRepositoriesForJob(job, repositories) {
  if (!repositories.length) {
    return repositories;
  }

  if (getRepositoryMode() !== "global") {
    return Promise.all(repositories.map((repo) => prepareLocalRepository(repo)));
  }

  const checkoutRoot = path.join(getRepositoryCheckoutRoot(), job.id);
  await fsp.mkdir(checkoutRoot, { recursive: true });
  const prepared = [];

  for (let index = 0; index < repositories.length; index += 1) {
    const repo = repositories[index];
    if (!repo.url) {
      prepared.push(stripRepositorySecrets(repo));
      continue;
    }

    const targetPath = path.join(checkoutRoot, `${index + 1}-${getRepositoryFolderName(repo, index)}`);
    emitJob(job, "log", { message: `Клонирую репозиторий ${repo.url}, ветка ${repo.branch || getDefaultRepositoryBranch()}.` });
    await cloneRepository(repo, targetPath);
    prepared.push(stripRepositorySecrets({
      ...repo,
      path: targetPath,
      localPath: targetPath,
      sourceUrl: repo.url
    }));
  }

  return prepared;
}

async function prepareLocalRepository(repo) {
  if (!repo.path) {
    return stripRepositorySecrets(repo);
  }

  const resolvedPath = resolveAppPath(repo.path);
  const stat = await fsp.stat(resolvedPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    const error = new Error(`Локальный путь к репозиторию не найден или не является папкой: ${repo.path}`);
    error.statusCode = 400;
    throw error;
  }

  return stripRepositorySecrets({
    ...repo,
    path: resolvedPath,
    localPath: resolvedPath
  });
}

function stripRepositorySecrets(repo) {
  const { password, sshKey, ...safeRepo } = repo;
  return safeRepo;
}

function getRepositoryFolderName(repo, index) {
  const fromUrl = getRepositoryNameFromUrl(repo.url);
  return sanitizePathSegment(fromUrl || `repository-${index + 1}`);
}

function getRepositoryNameFromUrl(value) {
  try {
    const parsed = new URL(value);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return lastSegment.replace(/\.git$/i, "");
  } catch {
    const normalized = String(value || "").replace(/\\/g, "/");
    const lastSegment = normalized.split("/").filter(Boolean).pop() || "";
    return lastSegment.replace(/\.git$/i, "");
  }
}

async function cloneRepository(repo, targetPath) {
  const branch = repo.branch || getDefaultRepositoryBranch();
  const auth = await createGitAuthOptions(repo);
  const secrets = [repo.password, repo.sshKey].filter(Boolean);
  try {
    await runProcess("git", ["clone", "--depth", "1", "--branch", branch, repo.url, targetPath], {
      timeoutMs: Number(config.service?.repositoryCloneTimeoutMs || 10 * 60 * 1000),
      env: {
        ...auth.env,
        GIT_TERMINAL_PROMPT: "0"
      },
      windowsHide: true
    });
  } catch (error) {
    throw new Error(maskSensitiveText(`Не удалось скачать репозиторий ${repo.url}: ${error.message}`, secrets));
  } finally {
    await auth.cleanup();
  }
}

async function createGitAuthOptions(repo) {
  if (repo.authType === "ssh") {
    return createSshGitAuthOptions(repo);
  }
  if (repo.authType === "basic") {
    return createBasicGitAuthOptions(repo);
  }
  return { env: {}, cleanup: async () => {} };
}

async function createBasicGitAuthOptions(repo) {
  if (!repo.username || !repo.password) {
    throw new Error("Для аутентификации по логину и паролю/токену заполните оба поля.");
  }

  const scriptPath = path.join(os.tmpdir(), `git-askpass-${crypto.randomUUID()}${process.platform === "win32" ? ".cmd" : ".sh"}`);
  const helperPath = process.platform === "win32" ? path.join(os.tmpdir(), `git-askpass-${crypto.randomUUID()}.js`) : "";
  const script = process.platform === "win32"
    ? `@echo off\r\nnode "${helperPath}" %*\r\n`
    : "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$GIT_REPOSITORY_USERNAME\" ;;\n  *) printf '%s\\n' \"$GIT_REPOSITORY_PASSWORD\" ;;\nesac\n";

  if (helperPath) {
    await fsp.writeFile(
      helperPath,
      "const prompt = process.argv.slice(2).join(' ');\nconst key = /username/i.test(prompt) ? 'GIT_REPOSITORY_USERNAME' : 'GIT_REPOSITORY_PASSWORD';\nprocess.stdout.write(`${process.env[key] || ''}\\n`);\n",
      { encoding: "utf8", mode: 0o700 }
    );
  }
  await fsp.writeFile(scriptPath, script, { encoding: "utf8", mode: 0o700 });
  return {
    env: {
      GIT_ASKPASS: scriptPath,
      GIT_REPOSITORY_USERNAME: repo.username,
      GIT_REPOSITORY_PASSWORD: repo.password
    },
    cleanup: async () => {
      await fsp.rm(scriptPath, { force: true });
      if (helperPath) {
        await fsp.rm(helperPath, { force: true });
      }
    }
  };
}

async function createSshGitAuthOptions(repo) {
  if (!repo.sshKey) {
    throw new Error("Для SSH-аутентификации добавьте приватный ключ.");
  }

  const keyPath = path.join(os.tmpdir(), `git-ssh-key-${crypto.randomUUID()}`);
  await fsp.writeFile(keyPath, normalizePrivateKey(repo.sshKey), { encoding: "utf8", mode: 0o600 });
  return {
    env: {
      GIT_SSH_COMMAND: `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`
    },
    cleanup: async () => {
      await fsp.rm(keyPath, { force: true });
    }
  };
}

function normalizePrivateKey(value) {
  return String(value).replace(/\r?\n/g, "\n").trimEnd() + "\n";
}

function maskSensitiveText(text, secrets) {
  return secrets.reduce((result, secret) => {
    return secret ? result.split(secret).join("[secret]") : result;
  }, String(text || ""));
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map(compact).filter(Boolean);
}

function compact(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildClarityRubric() {
  return [
    "Оцени ясность функционала по 10-балльной шкале и кратко объясни:",
    "1. Понятность бизнес-сути.",
    "2. Понятность архитектуры.",
    "3. Достаточность предоставленной информации.",
    "4. Машиночитаемость предоставленной информации, учитывая что изображения считаются машинонечитаемыми."
  ].join("\n");
}

function buildRepositoryPrompt(repositories) {
  return [
    "Ты системный аналитик. Построй аналитику на основе предоставленных путей к репозиториям.",
    "Если CLI имеет доступ к файловой системе, изучи указанные каталоги. Не меняй исходные репозитории.",
    "",
    "Репозитории:",
    repositories.map((repo, index) => [
      `${index + 1}. Тип: ${repo.kind}`,
      `   Режим: ${repo.mode || getRepositoryMode()}`,
      repo.sourceUrl ? `   URL: ${repo.sourceUrl}` : "",
      repo.branch ? `   Ветка: ${repo.branch}` : "",
      `   Путь: ${repo.path || "не указан"}`,
      `   Описание: ${repo.description || "не указано"}`
    ].filter(Boolean).join("\n")).join("\n"),
    "",
    "Сформируй краткую системную аналитику: назначение, ключевые сценарии, доменные сущности, зависимости, риски, пробелы.",
    buildClarityRubric()
  ].join("\n");
}

function buildJiraPrompt(issues) {
  return [
    "Ты системный аналитик. Построй аналитику по описаниям задач Jira.",
    "",
    "Данные Jira:",
    issues.map(formatExternalRecord).join("\n\n"),
    "",
    "Выдели бизнес-требования, пользовательские сценарии, ограничения, открытые вопросы и противоречия.",
    buildClarityRubric()
  ].join("\n");
}

function buildFilesPrompt(files) {
  return [
    "Ты системный аналитик. Построй аналитику на основе загруженных файлов системной аналитики.",
    "",
    "Файлы:",
    files.map(formatExternalRecord).join("\n\n"),
    "",
    "Сделай выводы по требованиям, бизнес-правилам, интеграциям, ролям, состояниям и пробелам.",
    buildClarityRubric()
  ].join("\n");
}

function buildConfluencePrompt(pages) {
  return [
    "Ты системный аналитик. Построй и оптимизируй аналитику на основе страниц Confluence.",
    "",
    "Страницы Confluence:",
    pages.map(formatExternalRecord).join("\n\n"),
    "",
    "Устрани дубли, выдели структуру требований, архитектурные сведения, открытые вопросы и недостающие данные.",
    buildClarityRubric()
  ].join("\n");
}

function buildTaskDescriptionPrompt(description) {
  return [
    "Ты системный аналитик. Проанализируй свободное описание задачи.",
    "",
    description,
    "",
    "Выдели цель, бизнес-сценарии, ожидаемое поведение, ограничения, неоднозначности и вопросы.",
    buildClarityRubric()
  ].join("\n");
}

function buildFinalPrompt(stepResults, outputDir, options = {}) {
  const sections = stepResults.map((result, index) => [
    `## ${index + 1}. ${result.title}`,
    "```text",
    trimForPrompt(result.output, 120000),
    "```"
  ].join("\n")).join("\n\n");
  const outputProfile = normalizeSddProfile(options.outputProfile);
  const profileInstructions = buildSddProfileInstructions(outputProfile, options);

  return [
    "Ты ведущий системный аналитик и технический редактор.",
    "На основе всех результатов ниже создай иерархию папок с markdown-файлами системной аналитики.",
    `Сохрани результат строго в каталог: ${outputDir}`,
    options.sourceIndexPath ? `Индекс источников уже создан: ${options.sourceIndexPath}` : "",
    "",
    profileInstructions,
    "",
    "Требования к результату:",
    "- Материалы должны быть понятны не техническим специалистам.",
    "- Материалы должны быть полезны системному аналитику.",
    "- Материалы должны быть оптимальны для дальнейшего вайбкодинга автотестов и исходного кода.",
    "- Используй Mermaid/UML-диаграммы в markdown там, где это повышает понятность.",
    "- Не используй картинки как основной носитель требований.",
    "- Отдельно зафиксируй оценку ясности по бизнес-сути, архитектуре, достаточности информации и машиночитаемости.",
    "- Создай evidence-map.json: требование -> источники -> confidence -> комментарий.",
    "- Создай clarity-assessment.json с числовыми оценками 0-10 и причинами.",
    "- Создай open-questions.md, если есть неподтвержденные факты, противоречия или недостающие данные.",
    "",
    "Рекомендуемая структура:",
    "- 00-overview.md",
    "- business/context.md",
    "- business/scenarios.md",
    "- requirements/functional.md",
    "- requirements/non-functional.md",
    "- architecture/components.md",
    "- architecture/integrations.md",
    "- data/domain-model.md",
    "- quality/autotest-roadmap.md",
    "- clarity/assessment.md",
    "- open-questions.md",
    "",
    "Если часть данных отсутствует, явно отметь пробелы и вопросы, а не додумывай факты.",
    "",
    "# Входные результаты анализа",
    sections || "Нет промежуточных результатов."
  ].join("\n");
}

function buildSddProfileInstructions(outputProfile, options = {}) {
  const capabilities = options.capabilities || getSddCapabilities();
  const isCodex = options.cliName === "codex";
  const openSpecSkills = capabilities.openspec?.skills || [];
  const specKitSkills = capabilities.speckit?.skills || [];
  const lines = [`SDD-профиль результата: ${outputProfile}.`];

  if (["openspec", "hybrid"].includes(outputProfile)) {
    lines.push(
      "Сгенерируй OpenSpec-compatible структуру:",
      "- openspec/config.yaml",
      "- openspec/specs/<domain>/spec.md как source of truth текущего поведения",
      "- openspec/changes/generated-analysis/proposal.md",
      "- openspec/changes/generated-analysis/design.md",
      "- openspec/changes/generated-analysis/tasks.md",
      "- openspec/changes/generated-analysis/specs/<domain>/spec.md с delta specs ADDED/MODIFIED/REMOVED при необходимости."
    );
    if (isCodex && openSpecSkills.length) {
      lines.push(
        `В этом проекте обнаружены OpenSpec skills: ${openSpecSkills.join(", ")}.`,
        "Если Codex позволяет вызвать skills в этом режиме, используй $openspec-propose для структуры change и $openspec-verify-change для самопроверки результата.",
        "Если skill-вызов недоступен, создай совместимые файлы вручную по OpenSpec-формату."
      );
    } else {
      lines.push("OpenSpec skills не обнаружены для текущего CLI; создай OpenSpec-compatible файлы вручную.");
    }
  }

  if (["speckit", "hybrid"].includes(outputProfile)) {
    lines.push(
      "Сгенерируй Spec Kit-compatible структуру:",
      "- .specify/memory/constitution.md",
      "- specs/001-system-analysis/spec.md",
      "- specs/001-system-analysis/research.md",
      "- specs/001-system-analysis/plan.md",
      "- specs/001-system-analysis/tasks.md",
      "- specs/001-system-analysis/checklists/requirements.md."
    );
    if (isCodex && specKitSkills.length) {
      lines.push(
        `В этом проекте обнаружены Spec Kit skills: ${specKitSkills.join(", ")}.`,
        "Если Codex позволяет вызвать skills в этом режиме, используй $speckit-specify, $speckit-plan, $speckit-tasks и $speckit-analyze как ориентир процесса.",
        "Если skill-вызов недоступен, создай совместимые файлы вручную по Spec Kit-формату."
      );
    } else {
      lines.push("Spec Kit skills не обнаружены для текущего CLI; создай Spec Kit-compatible файлы вручную.");
    }
  }

  if (outputProfile === "markdown") {
    lines.push("Сгенерируй обычную markdown-иерархию без обязательной совместимости с OpenSpec или Spec Kit.");
  }

  return lines.join("\n");
}

function formatExternalRecord(record, index) {
  const title = record.title || record.url || record.originalName || `Элемент ${index + 1}`;
  const body = record.content || record.error || "";
  return [
    `### ${title}`,
    record.url ? `URL: ${record.url}` : "",
    record.path ? `Путь: ${record.path}` : "",
    record.meta ? `Метаданные: ${JSON.stringify(record.meta, null, 2)}` : "",
    record.error ? `Ошибка чтения: ${record.error}` : "",
    "```text",
    trimForPrompt(body, 80000),
    "```"
  ].filter(Boolean).join("\n");
}

function trimForPrompt(text, maxLength) {
  const value = String(text || "");
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n\n[Фрагмент обрезан: ${value.length - maxLength} символов не включено]`;
}

async function collectUploadedFilesContext(fileIds) {
  const maxInlineBytes = Number(config.maxInlineFileBytes || 256 * 1024);
  const result = [];

  for (const id of fileIds) {
    const record = uploads.get(id);
    if (!record) {
      result.push({
        title: id,
        error: "Файл не найден среди загруженных."
      });
      continue;
    }

    const stat = await fsp.stat(record.storagePath);
    const context = {
      title: record.originalName,
      originalName: record.originalName,
      path: record.storagePath,
      meta: {
        mimeType: record.mimeType,
        size: stat.size,
        uploadedAt: record.uploadedAt
      },
      content: ""
    };

    if (stat.size <= maxInlineBytes) {
      const buffer = await fsp.readFile(record.storagePath);
      if (looksLikeText(buffer)) {
        context.content = buffer.toString("utf8");
      } else {
        context.content = "Файл похож на бинарный или изображение; содержимое не встроено в запрос. Используй путь к файлу, если CLI умеет читать локальные файлы.";
      }
    } else {
      context.content = `Файл больше лимита встраивания (${maxInlineBytes} байт). Используй путь к файлу, если CLI умеет читать локальные файлы.`;
    }

    result.push(context);
  }

  return result;
}

function looksLikeText(buffer) {
  if (!buffer.length) {
    return true;
  }
  const sample = buffer.slice(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) {
    return false;
  }
  const decoded = sample.toString("utf8");
  const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
  return replacementCount / Math.max(decoded.length, 1) < 0.02;
}

async function collectJiraContext(job, links) {
  const integration = config.integrations?.jira;
  const result = [];

  for (const link of links) {
    emitJob(job, "log", { message: `Читаю Jira: ${link}` });
    try {
      const issueKey = extractJiraIssueKey(link);
      if (!issueKey) {
        throw new Error("Не удалось определить ключ задачи из ссылки.");
      }

      const fields = (integration.issueFields || ["summary", "description"]).join(",");
      const apiUrl = new URL(
        `/rest/api/${integration.restApiVersion || "2"}/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields)}`,
        normalizeBaseUrl(integration.baseUrl)
      ).toString();
      const issue = await requestUrl(apiUrl, { integration, responseType: "json" });
      result.push(formatJiraIssue(link, issueKey, issue));
    } catch (error) {
      result.push({
        title: link,
        url: link,
        error: error.message,
        content: ""
      });
    }
  }

  return result;
}

function extractJiraIssueKey(link) {
  try {
    const url = new URL(link);
    const selectedIssue = url.searchParams.get("selectedIssue");
    if (selectedIssue) {
      return selectedIssue;
    }
  } catch {
    // Plain issue keys are also supported.
  }
  return link.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] || "";
}

function formatJiraIssue(link, issueKey, issue) {
  const fields = issue.fields || {};
  const lines = [
    `Ключ: ${issueKey}`,
    `Заголовок: ${fields.summary || ""}`,
    `Тип: ${fields.issuetype?.name || ""}`,
    `Статус: ${fields.status?.name || ""}`,
    `Приоритет: ${fields.priority?.name || ""}`,
    `Метки: ${Array.isArray(fields.labels) ? fields.labels.join(", ") : ""}`,
    `Компоненты: ${Array.isArray(fields.components) ? fields.components.map((item) => item.name).join(", ") : ""}`,
    "",
    "Описание:",
    typeof fields.description === "string" ? fields.description : JSON.stringify(fields.description || "", null, 2)
  ];

  return {
    title: `${issueKey}: ${fields.summary || ""}`,
    url: link,
    meta: {
      self: issue.self,
      id: issue.id
    },
    content: lines.join("\n")
  };
}

async function collectConfluenceContext(job, links) {
  const integration = config.integrations?.confluence;
  const result = [];

  for (const link of links) {
    emitJob(job, "log", { message: `Читаю Confluence: ${link}` });
    try {
      const page = await fetchConfluencePage(integration, link);
      result.push(page);
    } catch (error) {
      result.push({
        title: link,
        url: link,
        error: error.message,
        content: ""
      });
    }
  }

  return result;
}

async function fetchConfluencePage(integration, link) {
  const pageId = extractConfluencePageId(link);
  if (pageId) {
    try {
      const restBasePath = integration.restBasePath || "/rest/api";
      const apiUrl = new URL(
        `${restBasePath.replace(/\/$/, "")}/content/${encodeURIComponent(pageId)}?expand=body.storage,body.view,title,space,version`,
        normalizeBaseUrl(integration.baseUrl)
      ).toString();
      const page = await requestUrl(apiUrl, { integration, responseType: "json" });
      const html = page.body?.storage?.value || page.body?.view?.value || "";
      return {
        title: page.title || link,
        url: link,
        meta: {
          id: page.id,
          space: page.space?.key,
          version: page.version?.number
        },
        content: stripHtml(html)
      };
    } catch {
      // Fall through to direct page fetch; some installations do not expose REST by page id.
    }
  }

  const html = await requestUrl(link, { integration, responseType: "text", maxBytes: 25 * 1024 * 1024 });
  return {
    title: link,
    url: link,
    content: stripHtml(html)
  };
}

function extractConfluencePageId(link) {
  try {
    const url = new URL(link);
    const pageId = url.searchParams.get("pageId");
    if (pageId) {
      return pageId;
    }
  } catch {
    // Continue with regex fallback.
  }

  return link.match(/(?:pages|content)\/(\d+)/i)?.[1] || "";
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function requestUrl(targetUrl, options) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const isHttps = parsedUrl.protocol === "https:";
    const requestLib = isHttps ? https : http;
    const tlsOptions = isHttps ? buildTlsOptions(options.integration) : {};
    const maxBytes = options.maxBytes || 25 * 1024 * 1024;

    const request = requestLib.request(parsedUrl, {
      ...tlsOptions,
      method: "GET",
      headers: {
        Accept: options.responseType === "json" ? "application/json" : "*/*"
      }
    }, (response) => {
      const chunks = [];
      let total = 0;

      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          request.destroy(new Error("Ответ сервера слишком большой."));
          return;
        }
        chunks.push(chunk);
      });

      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 500)}`));
          return;
        }

        if (options.responseType === "json") {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Не удалось разобрать JSON: ${error.message}`));
          }
        } else {
          resolve(body);
        }
      });
    });

    request.on("error", reject);
    request.end();
  });
}

function buildTlsOptions(integration) {
  const certificate = integration?.certificate || {};
  const options = {
    rejectUnauthorized: certificate.rejectUnauthorized !== false
  };

  if (certificate.pfxPath) {
    options.pfx = fs.readFileSync(resolveAppPath(certificate.pfxPath));
  }
  if (certificate.certPath) {
    options.cert = fs.readFileSync(resolveAppPath(certificate.certPath));
  }
  if (certificate.keyPath) {
    options.key = fs.readFileSync(resolveAppPath(certificate.keyPath));
  }
  if (certificate.caPath) {
    options.ca = fs.readFileSync(resolveAppPath(certificate.caPath));
  }
  if (certificate.passphraseEnv && process.env[certificate.passphraseEnv]) {
    options.passphrase = process.env[certificate.passphraseEnv];
  }

  return options;
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    throw new Error("Base URL не задан в config.json.");
  }
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function resolveAppPath(value) {
  if (!value) {
    return APP_ROOT;
  }

  const expanded = String(value)
    .replace(/\$\{APP_ROOT\}/g, APP_ROOT)
    .replace(/^~(?=$|[/\\])/, os.homedir());

  return path.isAbsolute(expanded) ? expanded : path.resolve(APP_ROOT, expanded);
}

async function writeJobTranscript(outputDir, job, stepResults) {
  const lines = [
    "# CLI transcript",
    "",
    `Job: ${job.id}`,
    `Created: ${job.createdAt}`,
    "",
    "## Steps",
    "",
    ...stepResults.map((step) => [
      `### ${step.title}`,
      "",
      "#### Output",
      "",
      "```text",
      step.output || "",
      "```",
      ""
    ].join("\n")),
    "## Events",
    "",
    "```json",
    JSON.stringify(job.transcript, null, 2),
    "```"
  ];

  await fsp.writeFile(path.join(outputDir, "cli-transcript.md"), lines.join("\n"), "utf8");
}
