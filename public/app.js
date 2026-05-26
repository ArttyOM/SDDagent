const state = {
  config: null,
  uploads: [],
  activeJobId: null,
  eventSource: null
};

const repoList = document.querySelector("#repoList");
const fileList = document.querySelector("#fileList");
const jiraList = document.querySelector("#jiraList");
const confluenceList = document.querySelector("#confluenceList");
const createButton = document.querySelector("#createAnalytics");
const stopButton = document.querySelector("#stopJob");
const actionStatus = document.querySelector("#actionStatus");
const cliOutput = document.querySelector("#cliOutput");
const cliInput = document.querySelector("#cliInput");
const sendCliInputButton = document.querySelector("#sendCliInput");
const cliInputHelp = document.querySelector("#cliInputHelp");
const outputProfileSelect = document.querySelector("#outputProfile");
const sddCapabilities = document.querySelector("#sddCapabilities");
const activeCliName = document.querySelector("#activeCliName");
const activeCliCommand = document.querySelector("#activeCliCommand");
const cliConfigHint = document.querySelector("#cliConfigHint");

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  await loadConfig();
  addRepoRow();
  addLinkRow(jiraList);
  addLinkRow(confluenceList);
  await loadUploads();
  refreshCreateState();
}

function bindEvents() {
  document.querySelector("#addRepo").addEventListener("click", () => addRepoRow());
  document.querySelector("#addJira").addEventListener("click", () => addLinkRow(jiraList));
  document.querySelector("#addConfluence").addEventListener("click", () => addLinkRow(confluenceList));
  document.querySelector("#analysisFiles").addEventListener("change", uploadSelectedFiles);
  document.querySelector("#authJira").addEventListener("click", () => authenticate("jira"));
  document.querySelector("#authConfluence").addEventListener("click", () => authenticate("confluence"));
  createButton.addEventListener("click", createAnalytics);
  stopButton.addEventListener("click", stopJob);
  sendCliInputButton.addEventListener("click", sendCliInput);
  document.querySelector("#taskDescription").addEventListener("input", refreshCreateState);
  outputProfileSelect.addEventListener("change", refreshCreateState);
}

async function loadConfig() {
  try {
    state.config = await apiGet("/api/config");
    const repositoryMode = getRepositoryMode();
    document.querySelector("#configStatus").textContent = `CLI: ${state.config.cli?.active || "codex"} · Режим: ${repositoryMode} · Результаты: ${state.config.outputDirectory}`;
    document.querySelector("#jiraHint").textContent = state.config.integrations.jira.configured
      ? state.config.integrations.jira.baseUrl
      : "URL Jira не задан в config.json";
    document.querySelector("#confluenceHint").textContent = state.config.integrations.confluence.configured
      ? state.config.integrations.confluence.baseUrl
      : "URL Confluence не задан в config.json";
    renderAuthState("jira", state.config.integrations.jira.auth);
    renderAuthState("confluence", state.config.integrations.confluence.auth);
    renderCliConfig(state.config.cli);
    renderSddConfig(state.config.sdd);
  } catch (error) {
    document.querySelector("#configStatus").textContent = error.message;
  }
}

function renderCliConfig(cli) {
  if (!cli) {
    return;
  }

  const active = cli.active || cli.default || "codex";
  const options = Array.isArray(cli.options) && cli.options.length ? cli.options : [active];
  activeCliName.textContent = active;
  activeCliCommand.textContent = cli.configured
    ? `${cli.command || active}${cli.cwd ? ` · cwd: ${cli.cwd}` : ""}`
    : "Не настроен";
  cliConfigHint.textContent = cli.configured
    ? `Чтобы переключиться между ${options.join(" / ")}, измените cli.active в config.json и перезапустите сервер.`
    : `CLI "${active}" не найден в config.json: cli.commands.`;
}

function renderSddConfig(sdd) {
  if (!sdd) {
    return;
  }

  const profiles = sdd.profiles || ["markdown", "openspec", "speckit", "hybrid"];
  [...outputProfileSelect.options].forEach((option) => {
    option.hidden = !profiles.includes(option.value);
  });
  outputProfileSelect.value = sdd.defaultProfile || "markdown";

  const openSpec = sdd.capabilities?.openspec;
  const specKit = sdd.capabilities?.speckit;
  const openSpecStatus = openSpec?.available
    ? `OpenSpec: готово (${openSpec.skills?.length || 0} skills${openSpec.cli ? ", CLI" : ""})`
    : "OpenSpec: skills/CLI не найдены";
  const specKitStatus = specKit?.available
    ? `Spec Kit: готово (${specKit.skills?.length || 0} skills${specKit.cli ? ", CLI" : ""})`
    : "Spec Kit: skills/CLI не найдены";
  sddCapabilities.textContent = `${openSpecStatus}. ${specKitStatus}.`;
}

async function loadUploads() {
  const response = await apiGet("/api/uploads");
  state.uploads = response.files || [];
  renderFiles();
}

function addRepoRow(value = {}) {
  const template = document.querySelector("#repoRowTemplate");
  const row = template.content.firstElementChild.cloneNode(true);
  configureRepositoryRowMode(row);
  row.querySelector(".repo-path").value = value.path || "";
  row.querySelector(".repo-url").value = value.url || "";
  row.querySelector(".repo-branch").value = value.branch || "";
  row.querySelector(".repo-auth-type").value = value.authType || "none";
  row.querySelector(".repo-username").value = value.username || "";
  row.querySelector(".repo-password").value = value.password || "";
  row.querySelector(".repo-ssh-key").value = value.sshKey || "";
  row.querySelector(".repo-description").value = value.description || "";
  row.querySelector(".repo-kind").value = value.kind || "исходный код";
  row.querySelector(".delete-row").addEventListener("click", () => {
    row.remove();
    refreshCreateState();
  });
  row.querySelector(".pick-path").addEventListener("click", () => {
    pickLocalRepositoryPath(row);
  });
  row.querySelector(".repo-auth-type").addEventListener("change", () => {
    updateRepositoryAuthFields(row);
  });
  row.querySelectorAll("input, select").forEach((input) => {
    input.addEventListener("input", refreshCreateState);
    input.addEventListener("change", refreshCreateState);
  });
  row.querySelector(".repo-ssh-key").addEventListener("input", refreshCreateState);
  repoList.appendChild(row);
  updateRepositoryAuthFields(row);
  refreshCreateState();
}

function configureRepositoryRowMode(row) {
  const mode = getRepositoryMode();
  row.classList.toggle("global", mode === "global");
  row.classList.toggle("local", mode !== "global");
}

function getRepositoryMode() {
  return state.config?.service?.mode === "global" ? "global" : "local";
}

function updateRepositoryAuthFields(row) {
  const authType = row.querySelector(".repo-auth-type").value;
  row.querySelector(".repo-basic-auth").classList.toggle("hidden", authType !== "basic");
  row.querySelector(".repo-ssh-auth").classList.toggle("hidden", authType !== "ssh");
}

async function pickLocalRepositoryPath(row) {
  const button = row.querySelector(".pick-path");
  button.disabled = true;
  appendCliOutput("\n[web] Открываю выбор локального пути к репозиторию.\n");

  try {
    const body = await apiPost("/api/pick-directory", {});
    row.querySelector(".repo-path").value = body.path || "";
    appendCliOutput(`[web] Выбран локальный путь: ${body.path || ""}\n`);
    refreshCreateState();
  } catch (error) {
    appendCliOutput(`\n[web] ${error.message}\n`);
  } finally {
    button.disabled = false;
  }
}

function addLinkRow(container, value = "") {
  const template = document.querySelector("#linkRowTemplate");
  const row = template.content.firstElementChild.cloneNode(true);
  row.querySelector(".link-input").value = value;
  row.querySelector(".delete-row").addEventListener("click", () => {
    row.remove();
    refreshCreateState();
  });
  row.querySelector(".link-input").addEventListener("input", refreshCreateState);
  container.appendChild(row);
  refreshCreateState();
}

async function uploadSelectedFiles(event) {
  const files = [...event.target.files];
  if (!files.length) {
    return;
  }

  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  try {
    const response = await fetch("/api/uploads", {
      method: "POST",
      body: formData
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "Не удалось загрузить файлы.");
    }
    state.uploads = [...state.uploads, ...(body.files || [])];
    renderFiles();
    refreshCreateState();
  } catch (error) {
    appendCliOutput(`\n[web] ${error.message}\n`);
  } finally {
    event.target.value = "";
  }
}

function renderFiles() {
  fileList.innerHTML = "";
  for (const file of state.uploads) {
    const item = document.createElement("div");
    item.className = "file-item";

    const name = document.createElement("div");
    name.innerHTML = `<strong>${escapeHtml(file.originalName)}</strong><div class="file-meta">${formatBytes(file.size)} · ${escapeHtml(file.mimeType || "application/octet-stream")}</div>`;

    const uploaded = document.createElement("div");
    uploaded.className = "file-meta";
    uploaded.textContent = new Date(file.uploadedAt).toLocaleString();

    const remove = document.createElement("button");
    remove.className = "icon-btn delete-row";
    remove.type = "button";
    remove.title = "Удалить файл";
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-.7 11H7.7L7 9Zm3 2 .2 7h1.8l-.1-7H10Zm4 0-.1 7h1.8l.3-7h-2Z"/></svg>';
    remove.addEventListener("click", () => deleteUpload(file.id));

    item.append(name, uploaded, remove);
    fileList.appendChild(item);
  }
}

async function deleteUpload(id) {
  try {
    await apiDelete(`/api/uploads/${encodeURIComponent(id)}`);
    state.uploads = state.uploads.filter((file) => file.id !== id);
    renderFiles();
    refreshCreateState();
  } catch (error) {
    appendCliOutput(`\n[web] ${error.message}\n`);
  }
}

async function authenticate(service) {
  const button = document.querySelector(service === "jira" ? "#authJira" : "#authConfluence");
  const integration = state.config?.integrations?.[service] || {};
  const isBrowserAuth = integration.authMode === "browser";
  button.disabled = true;
  renderAuthState(service, {
    ok: false,
    status: "pending",
    message: isBrowserAuth ? "Открываю страницу аутентификации..." : "Проверяем сертификат..."
  });
  try {
    if (isBrowserAuth) {
      if (!integration.browserAuthUrl) {
        throw new Error(`URL браузерной аутентификации для ${service} не задан в config.json.`);
      }

      const authWindow = window.open(integration.browserAuthUrl, "_blank");
      if (!authWindow) {
        throw new Error("Браузер заблокировал всплывающее окно. Разрешите всплывающие окна для этого приложения и повторите попытку.");
      }
      try {
        authWindow.opener = null;
      } catch {
        // Some browsers protect this property after cross-origin navigation.
      }
    }

    const state = await apiPost(`/api/auth/${service}`, {});
    renderAuthState(service, state);
  } catch (error) {
    renderAuthState(service, { ok: false, message: error.message });
  } finally {
    button.disabled = false;
  }
}

function renderAuthState(service, value) {
  const element = document.querySelector(service === "jira" ? "#jiraAuth" : "#confluenceAuth");
  const prefix = value?.ok ? "Готово" : value?.status === "opened" ? "Открыто" : "Статус";
  element.textContent = `${prefix}: ${value?.message || "Не проверено"}`;
  element.style.color = value?.ok ? "#0d5f2a" : value?.status === "opened" ? "#0b5f7a" : "#5f7c68";
}

function gatherPayload() {
  return {
    outputProfile: outputProfileSelect.value || "markdown",
    repositories: [...repoList.querySelectorAll(".repo-row")].map((row) => ({
      mode: getRepositoryMode(),
      path: row.querySelector(".repo-path").value.trim(),
      url: row.querySelector(".repo-url").value.trim(),
      branch: row.querySelector(".repo-branch").value.trim(),
      authType: row.querySelector(".repo-auth-type").value,
      username: row.querySelector(".repo-username").value.trim(),
      password: row.querySelector(".repo-password").value,
      sshKey: row.querySelector(".repo-ssh-key").value,
      description: row.querySelector(".repo-description").value.trim(),
      kind: row.querySelector(".repo-kind").value
    })),
    files: state.uploads.map((file) => file.id),
    jiraLinks: gatherLinks(jiraList),
    confluenceLinks: gatherLinks(confluenceList),
    taskDescription: document.querySelector("#taskDescription").value.trim()
  };
}

function gatherLinks(container) {
  return [...container.querySelectorAll(".link-input")]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function refreshCreateState() {
  const payload = gatherPayload();
  const hasRepos = payload.repositories.some((repo) => repo.path || repo.url || repo.description);
  const hasData = hasRepos
    || payload.files.length
    || payload.jiraLinks.length
    || payload.confluenceLinks.length
    || payload.taskDescription;

  createButton.disabled = !hasData || Boolean(state.activeJobId);
  actionStatus.textContent = hasData
    ? "Готово к запуску."
    : "Добавьте хотя бы один источник данных.";
}

async function createAnalytics() {
  const payload = gatherPayload();
  cliOutput.value = "";
  createButton.disabled = true;
  actionStatus.textContent = "Запускаю обработку...";

  try {
    const response = await apiPost("/api/jobs", payload);
    state.activeJobId = response.jobId;
    stopButton.classList.remove("hidden");
    sendCliInputButton.disabled = false;
    cliInputHelp.textContent = "Кнопка активна: можно отправлять в CLI ответы на уточнения и разрешения.";
    connectJobEvents(response.jobId);
  } catch (error) {
    appendCliOutput(`[web] ${error.message}\n`);
    state.activeJobId = null;
    stopButton.classList.add("hidden");
    refreshCreateState();
  }
}

function connectJobEvents(jobId) {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const eventSource = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  state.eventSource = eventSource;

  eventSource.addEventListener("status", (event) => {
    const data = JSON.parse(event.data);
    actionStatus.textContent = data.outputDir
      ? `${data.message} Результат: ${data.outputDir}`
      : data.message;
    appendCliOutput(`\n[status] ${data.message}${data.outputDir ? ` ${data.outputDir}` : ""}\n`);
    if (["completed", "failed", "stopped"].includes(data.status)) {
      finishJob();
    }
  });

  eventSource.addEventListener("step", (event) => {
    const data = JSON.parse(event.data);
    appendCliOutput(`\n[step:${data.status}] ${data.title}\n`);
  });

  eventSource.addEventListener("log", (event) => {
    const data = JSON.parse(event.data);
    appendCliOutput(`[log] ${data.message}\n`);
  });

  eventSource.addEventListener("cli-output", (event) => {
    const data = JSON.parse(event.data);
    appendCliOutput(data.text);
  });

  eventSource.addEventListener("error", (event) => {
    const data = JSON.parse(event.data);
    appendCliOutput(`\n[error] ${data.message}\n`);
  });

  eventSource.onerror = () => {
    if (state.activeJobId) {
      appendCliOutput("\n[web] Поток событий CLI прерван.\n");
    }
  };
}

function finishJob() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.activeJobId = null;
  stopButton.classList.add("hidden");
  sendCliInputButton.disabled = true;
  cliInputHelp.textContent = "Кнопка станет активна после запуска обработки, когда выбранный CLI будет готов принимать уточнения или разрешения.";
  refreshCreateState();
}

async function sendCliInput() {
  const text = cliInput.value.trim();
  if (!text || !state.activeJobId) {
    return;
  }

  try {
    await apiPost(`/api/jobs/${encodeURIComponent(state.activeJobId)}/input`, { text });
    cliInput.value = "";
  } catch (error) {
    appendCliOutput(`\n[web] ${error.message}\n`);
  }
}

async function stopJob() {
  if (!state.activeJobId) {
    return;
  }
  await apiPost(`/api/jobs/${encodeURIComponent(state.activeJobId)}/stop`, {});
  finishJob();
}

function appendCliOutput(text) {
  cliOutput.value += text;
  cliOutput.scrollTop = cliOutput.scrollHeight;
}

async function apiGet(url) {
  const response = await fetch(url);
  return parseApiResponse(response);
}

async function apiPost(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return parseApiResponse(response);
}

async function apiDelete(url) {
  const response = await fetch(url, { method: "DELETE" });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || "Ошибка запроса.");
  }
  return body;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} Б`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} КБ`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
