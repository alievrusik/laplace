import http from "node:http";
import { URL } from "node:url";
import type { TelegramBot } from "./bot.js";

export class MiniAppServer {
  private server: http.Server | undefined;

  constructor(
    private readonly deps: {
      bot: TelegramBot;
      port: number;
      baseUrl?: string;
    },
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.deps.port, "0.0.0.0", () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    const base = this.deps.baseUrl ?? `http://localhost:${this.deps.port}`;
    console.log(`[miniapp] listening on ${base}`);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const requestUrl = new URL(req.url ?? "/", `http://localhost:${this.deps.port}`);

    try {
      if (method === "OPTIONS") {
        res.statusCode = 204;
        res.setHeader("Access-Control-Allow-Origin", this.allowedOriginHeader());
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-User-Id");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.end();
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/health") {
        this.sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/") {
        this.sendHtml(res, renderMiniAppHtml(this.deps.baseUrl));
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/dialog/state") {
        const userId = Number(requestUrl.searchParams.get("userId"));
        assertValidUserId(userId);
        const state = await this.deps.bot.miniAppGetDialogState(userId);
        this.sendJson(res, 200, state);
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/messages") {
        const userId = Number(requestUrl.searchParams.get("userId"));
        assertValidUserId(userId);
        const projectSlug = String(requestUrl.searchParams.get("projectSlug") ?? "");
        const messages = this.deps.bot.miniAppGetMessages({ userId, projectSlug });
        this.sendJson(res, 200, { messages });
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/workflow") {
        const projectSlug = String(requestUrl.searchParams.get("projectSlug") ?? "");
        const events = this.deps.bot.miniAppGetWorkflow({ projectSlug });
        this.sendJson(res, 200, { events });
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/artifact") {
        const projectSlug = String(requestUrl.searchParams.get("projectSlug") ?? "");
        const artifact = await this.deps.bot.miniAppGetArtifact(projectSlug);
        this.sendJson(res, 200, artifact);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/dialog/new") {
        const body = await readJsonBody(req);
        assertValidUserId(Number(body.userId));
        const dialog = await this.deps.bot.miniAppCreateDialog(
          Number(body.userId),
          body.projectSlug ? String(body.projectSlug) : undefined,
        );
        this.sendJson(res, 200, dialog);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/dialog/switch") {
        const body = await readJsonBody(req);
        assertValidUserId(Number(body.userId));
        const message = await this.deps.bot.miniAppSwitchProject(Number(body.userId), String(body.projectSlug ?? ""));
        this.sendJson(res, 200, { ok: true, message });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/mode") {
        const body = await readJsonBody(req);
        assertValidUserId(Number(body.userId));
        await this.deps.bot.miniAppSetMode(Number(body.userId), body.mode === "debug" ? "debug" : "user");
        this.sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/chat/send") {
        const body = await readJsonBody(req);
        assertValidUserId(Number(body.userId));
        const reply = await this.deps.bot.miniAppSendMessage({
          userId: Number(body.userId),
          projectSlug: String(body.projectSlug ?? ""),
          message: String(body.message ?? ""),
          profile: body.profile === "client" ? "client" : "admin",
        });
        this.sendJson(res, 200, { reply });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/action/analyze") {
        const body = await readJsonBody(req);
        assertValidUserId(Number(body.userId));
        const started = await this.deps.bot.miniAppAnalyze({
          userId: Number(body.userId),
          projectSlug: String(body.projectSlug ?? ""),
          inlineText: body.inlineText ? String(body.inlineText) : undefined,
        });
        this.sendJson(res, 200, { started });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/action/confirm") {
        const body = await readJsonBody(req);
        assertValidUserId(Number(body.userId));
        const result = await this.deps.bot.miniAppConfirm({ userId: Number(body.userId) });
        this.sendJson(res, 200, { result });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/action/estimate") {
        const body = await readJsonBody(req);
        assertValidUserId(Number(body.userId));
        const result = await this.deps.bot.miniAppEstimate({
          userId: Number(body.userId),
          projectSlug: String(body.projectSlug ?? ""),
        });
        this.sendJson(res, 200, { result });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/gigachat/embed") {
        const body = await readJsonBody(req);
        assertValidUserId(Number(body.userId));
        const result = await this.deps.bot.miniAppGigaChatEmbed({
          userId: Number(body.userId),
          projectSlug: String(body.projectSlug ?? ""),
          text: String(body.text ?? ""),
        });
        this.sendJson(res, 200, { result });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/gigachat/stt") {
        const body = await readJsonBody(req);
        assertValidUserId(Number(body.userId));
        const result = await this.deps.bot.miniAppGigaChatStt({
          userId: Number(body.userId),
          projectSlug: String(body.projectSlug ?? ""),
          audioBase64: String(body.audioBase64 ?? ""),
          sourceAudioRef: body.sourceAudioRef ? String(body.sourceAudioRef) : undefined,
        });
        this.sendJson(res, 200, { result });
        return;
      }

      this.sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      this.sendJson(res, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", this.allowedOriginHeader());
    res.end(body);
  }

  private sendHtml(res: http.ServerResponse, html: string): void {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  }

  private allowedOriginHeader(): string {
    if (!this.deps.baseUrl) return "*";
    try {
      return new URL(this.deps.baseUrl).origin;
    } catch {
      return "*";
    }
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function renderMiniAppHtml(baseUrl?: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Laplace Mini App</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #0f172a; color: #e2e8f0; }
    .root { display: grid; grid-template-columns: 1fr 320px; min-height: 100vh; }
    .chat { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input, textarea, select, button { border-radius: 8px; border: 1px solid #334155; background: #111827; color: #e2e8f0; padding: 8px; }
    button { cursor: pointer; }
    .messages { flex: 1; overflow: auto; border: 1px solid #334155; border-radius: 12px; padding: 12px; background: #020617; }
    .msg { margin-bottom: 8px; padding: 8px; border-radius: 8px; background: #1e293b; }
    .aside { border-left: 1px solid #334155; padding: 16px; background: #0b1220; }
    .artifact { border: 1px solid #334155; border-radius: 12px; padding: 10px; background: #111827; }
    .small { font-size: 12px; opacity: .8; }
  </style>
</head>
<body>
  <div class="root">
  <div class="chat">
    <div class="row">
      <input id="userId" type="number" placeholder="userId"/>
      <input id="project" placeholder="project slug"/>
      <button onclick="createDialog()">new dialog</button>
      <button onclick="switchProject()">switch</button>
      <button onclick="loadState()">refresh</button>
      <select id="mode"><option value="user">user</option><option value="debug">debug</option></select>
      <button onclick="setMode()">set mode</button>
    </div>
    <div class="row">
      <button onclick="runAnalyze()">analyze</button>
      <button onclick="runConfirm()">confirm</button>
      <button onclick="runEstimate()">estimate</button>
      <button onclick="runGigaEmbed()">gigachat embed</button>
      <button onclick="runGigaStt()">gigachat stt (base64)</button>
    </div>
    <div id="messages" class="messages"></div>
    <div class="row">
      <textarea id="message" rows="3" style="flex:1" placeholder="Message"></textarea>
      <button onclick="sendMessage()">send</button>
    </div>
  </div>
    <div class="aside">
    <h3>Project Artifacts</h3>
    <div id="artifact" class="artifact"></div>
    <h4>Dialogs</h4>
    <div id="dialogs" class="small"></div>
    <h4>Workflow</h4>
    <div id="workflow" class="small"></div>
  </div>
</div>
<script>
const baseUrl = ${JSON.stringify(baseUrl ?? "")};
const resolvedBaseUrl = baseUrl || window.location.origin;
async function api(path, options={}) {
  const res = await fetch(resolvedBaseUrl + path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  return res.json();
}
function getUserId() { return Number(document.getElementById("userId").value || "0"); }
function getProject() { return document.getElementById("project").value.trim(); }
async function loadState() {
  const userId = getUserId();
  if (!userId) return;
  const state = await api("/api/dialog/state?userId=" + encodeURIComponent(userId));
  document.getElementById("dialogs").textContent = JSON.stringify(state, null, 2);
  if (state.activeProject) document.getElementById("project").value = state.activeProject;
  await refreshMessages();
  await refreshArtifact();
}
async function createDialog() {
  const data = await api("/api/dialog/new", { method: "POST", body: JSON.stringify({ userId: getUserId(), projectSlug: getProject() }) });
  document.getElementById("project").value = data.projectSlug;
  await loadState();
}
async function switchProject() {
  await api("/api/dialog/switch", { method: "POST", body: JSON.stringify({ userId: getUserId(), projectSlug: getProject() }) });
  await loadState();
}
async function setMode() {
  await api("/api/mode", { method: "POST", body: JSON.stringify({ userId: getUserId(), mode: document.getElementById("mode").value }) });
}
async function sendMessage() {
  const message = document.getElementById("message").value.trim();
  if (!message) return;
  await api("/api/chat/send", { method: "POST", body: JSON.stringify({ userId: getUserId(), projectSlug: getProject(), message }) });
  document.getElementById("message").value = "";
  await refreshMessages();
}
async function runAnalyze() {
  await api("/api/action/analyze", { method: "POST", body: JSON.stringify({ userId: getUserId(), projectSlug: getProject() }) });
  await refreshMessages();
}
async function runConfirm() {
  await api("/api/action/confirm", { method: "POST", body: JSON.stringify({ userId: getUserId() }) });
  await refreshMessages();
  await refreshArtifact();
}
async function runEstimate() {
  await api("/api/action/estimate", { method: "POST", body: JSON.stringify({ userId: getUserId(), projectSlug: getProject() }) });
  await refreshMessages();
}
async function runGigaEmbed() {
  const text = document.getElementById("message").value.trim();
  await api("/api/gigachat/embed", { method: "POST", body: JSON.stringify({ userId: getUserId(), projectSlug: getProject(), text }) });
  await refreshMessages();
}
async function runGigaStt() {
  const audioBase64 = document.getElementById("message").value.trim();
  await api("/api/gigachat/stt", { method: "POST", body: JSON.stringify({ userId: getUserId(), projectSlug: getProject(), audioBase64 }) });
  await refreshMessages();
}
async function refreshMessages() {
  const userId = getUserId();
  const projectSlug = getProject();
  if (!userId || !projectSlug) return;
  const data = await api("/api/messages?userId=" + encodeURIComponent(userId) + "&projectSlug=" + encodeURIComponent(projectSlug));
  const root = document.getElementById("messages");
  root.innerHTML = "";
  for (const msg of data.messages || []) {
    const el = document.createElement("div");
    el.className = "msg";
    const src = msg.sourceAgent ? "[" + msg.sourceAgent + "] " : "";
    el.textContent = src + msg.role + ": " + msg.text;
    root.appendChild(el);
  }
  root.scrollTop = root.scrollHeight;
}
async function refreshArtifact() {
  const projectSlug = getProject();
  if (!projectSlug) return;
  const data = await api("/api/artifact?projectSlug=" + encodeURIComponent(projectSlug));
  document.getElementById("artifact").textContent = JSON.stringify(data, null, 2);
}
async function refreshWorkflow() {
  const projectSlug = getProject();
  if (!projectSlug) return;
  const data = await api("/api/workflow?projectSlug=" + encodeURIComponent(projectSlug));
  const tail = (data.events || []).slice(-8);
  document.getElementById("workflow").textContent = JSON.stringify(tail, null, 2);
}
setInterval(() => { refreshMessages(); refreshArtifact(); refreshWorkflow(); }, 5000);
</script>
</body></html>`;
}

function assertValidUserId(userId: number): void {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error("Invalid userId");
  }
}
