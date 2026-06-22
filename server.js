import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "./src/config.js";
import { GitLabDuoClient } from "./src/duoClient.js";
import { GitLabGraphqlSchemaProbe } from "./src/graphqlProbe.js";
import {
  parseDevtoolsCurls,
  redactParsedCurlConfig,
} from "./src/curlParser.js";
import {
  completionResponse,
  messagesToPrompt,
  modelList,
  requireBearerToken,
  sseChunk,
  writeSse,
  writeSseDone,
  openApiSpec,
  normalizeContent,
  resolveGitLabModel,
} from "./src/openai.js";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: false, limit: "20mb" }));

const auth = requireBearerToken(config.adapterApiKey);
const CONFIG_FILE_PATH = path.join(process.cwd(), "runtime-config.json");
let runtimeGitLabConfig = { ...config.gitlab };
let lastParsedCurl = null;

try {
  if (fs.existsSync(CONFIG_FILE_PATH)) {
    const fileData = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, "utf8"));
    if (fileData.runtimeGitLabConfig) {
      runtimeGitLabConfig = { ...config.gitlab, ...fileData.runtimeGitLabConfig };
    }
    if (fileData.lastParsedCurl) {
      lastParsedCurl = fileData.lastParsedCurl;
    }
    console.log("Konfigurasi runtime berhasil dimuat dari runtime-config.json");
  }
} catch (err) {
  console.warn("Gagal memuat runtime-config.json:", err.message);
}

app.get("/", (_req, res) => {
  res.type("html").send(
    renderHomePage({
      wsConfigured: Boolean(runtimeGitLabConfig.wsUrl),
      graphqlConfigured: Boolean(runtimeGitLabConfig.graphql?.graphqlUrl),
      parsed: lastParsedCurl ? redactParsedCurlConfig(lastParsedCurl) : null,
      apiKey: config.adapterApiKey,
      modelId: config.modelId,
    }),
  );
});

app.post("/configure", (req, res) => {
  try {
    const curl = req.body.curl || "";
    const parsed = parseDevtoolsCurls(curl);

    lastParsedCurl = parsed;

    // Robust merge logic
    const existingGraphql = runtimeGitLabConfig.graphql || {};
    const wsNamespaceId = parsed.ws ? extractNamespaceId(parsed.ws.wsUrl) : "";
    const gqlNamespaceId = parsed.graphql ? parsed.graphql.namespaceId : "";
    const finalNamespaceId = wsNamespaceId || gqlNamespaceId || existingGraphql.namespaceId || "";

    const newWsConfig = parsed.ws
      ? {
          wsUrl: parsed.ws.wsUrl.replace(
            /workflow_id=[^&]+/,
            "workflow_id={{workflow_id}}",
          ),
          headers: {
            ...runtimeGitLabConfig.headers,
            ...parsed.ws.headers
          },
          modelIdentifier: extractModelIdentifier(parsed.ws.wsUrl) || runtimeGitLabConfig.modelIdentifier,
        }
      : {};

    const newGraphqlConfig = parsed.graphql
      ? {
          graphqlUrl: parsed.graphql.graphqlUrl,
          headers: {
            ...existingGraphql.headers,
            ...parsed.graphql.headers
          },
          workflowId: parsed.graphql.workflowId || existingGraphql.workflowId || "",
          namespaceId: finalNamespaceId,
        }
      : (runtimeGitLabConfig.graphql ? {
          ...runtimeGitLabConfig.graphql,
          namespaceId: finalNamespaceId
        } : null);

    runtimeGitLabConfig = {
      ...runtimeGitLabConfig,
      ...newWsConfig,
      ...(newGraphqlConfig ? { graphql: newGraphqlConfig } : {}),
    };

    // Save to disk
    try {
      fs.writeFileSync(
        CONFIG_FILE_PATH,
        JSON.stringify({ runtimeGitLabConfig, lastParsedCurl }, null, 2),
        "utf8"
      );
      console.log("Konfigurasi runtime berhasil disimpan ke runtime-config.json");
    } catch (err) {
      console.error("Gagal menyimpan runtime-config.json:", err.message);
    }

    res.type("html").send(
      renderHomePage({
        wsConfigured: Boolean(runtimeGitLabConfig.wsUrl),
        graphqlConfigured: Boolean(runtimeGitLabConfig.graphql?.graphqlUrl),
        parsed: redactParsedCurlConfig(parsed),
        apiKey: config.adapterApiKey,
        modelId: config.modelId,
        message: parsed.graphql
          ? "Curl GraphQL berhasil diparse dan disimpan. Fallback checkpoint tersedia."
          : "Curl WebSocket berhasil diparse dan disimpan.",
      }),
    );
  } catch (err) {
    res
      .status(400)
      .type("html")
      .send(
        renderHomePage({
          wsConfigured: Boolean(runtimeGitLabConfig.wsUrl),
          graphqlConfigured: Boolean(runtimeGitLabConfig.graphql?.graphqlUrl),
          parsed: lastParsedCurl
            ? redactParsedCurlConfig(lastParsedCurl)
            : null,
          apiKey: config.adapterApiKey,
          modelId: config.modelId,
          error: err.message,
        }),
      );
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(runtimeGitLabConfig.wsUrl),
    checkpointFallback: Boolean(runtimeGitLabConfig.graphql?.graphqlUrl),
  });
});

app.get("/debug/graphql-schema", auth, async (req, res) => {
  try {
    const terms =
      typeof req.query.terms === "string"
        ? req.query.terms
            .split(",")
            .map((term) => term.trim())
            .filter(Boolean)
        : undefined;
    const probe = new GitLabGraphqlSchemaProbe(runtimeGitLabConfig.graphql);
    res.json(await probe.search(terms));
  } catch (err) {
    res.status(500).json({
      error: {
        message: err.message,
        type: "gitlab_graphql_schema_probe_error",
      },
    });
  }
});

app.get(["/v1", "/v1/"], (_req, res) => {
  res.json(openApiSpec(config.modelId));
});

app.get("/v1/models", auth, async (_req, res) => {
  res.json(modelList(runtimeGitLabConfig.modelIdentifier || config.modelId));
});

app.post("/v1/chat/completions", auth, async (req, res) => {
  const { model = runtimeGitLabConfig.modelIdentifier || config.modelId, messages = [], stream = false } = req.body;
  const prompt = messagesToPrompt(messages);

  if (!runtimeGitLabConfig.graphql?.graphqlUrl) {
    return res.status(428).json({
      error: {
        message:
          "GitLab Duo belum dikonfigurasi. Buka / lalu paste HAR atau curl dari DevTools.",
        type: "gitlab_duo_not_configured",
      },
    });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: "messages must be a non-empty array",
        type: "invalid_request_error",
      },
    });
  }

  const hasAssistantMessage = messages.some(m => m.role === "assistant" || m.role === "agent");
  const firstUserMsgRaw = messages.find(m => m.role === "user")?.content || "";
  const firstUserMsg = normalizeContent(firstUserMsgRaw);
  const conversationKey = firstUserMsg ? crypto.createHash("sha256").update(firstUserMsg).digest("hex") : null;

  if (!runtimeGitLabConfig.workflows) {
    runtimeGitLabConfig.workflows = {};
  }

  let activeWorkflowId = null;
  if (hasAssistantMessage && conversationKey && runtimeGitLabConfig.workflows[conversationKey]) {
    activeWorkflowId = runtimeGitLabConfig.workflows[conversationKey];
  }

  const resolvedModelId = resolveGitLabModel(model, runtimeGitLabConfig.modelIdentifier || config.modelId);

  const duo = new GitLabDuoClient({
    ...runtimeGitLabConfig,
    modelIdentifier: resolvedModelId,
    graphql: {
      ...runtimeGitLabConfig.graphql,
      workflowId: activeWorkflowId || "",
    },
    onWorkflowCreated: (workflowGid) => {
      if (runtimeGitLabConfig.graphql) {
        runtimeGitLabConfig.graphql.workflowId = workflowGid;
        if (!runtimeGitLabConfig.workflows) {
          runtimeGitLabConfig.workflows = {};
        }
        if (conversationKey) {
          runtimeGitLabConfig.workflows[conversationKey] = workflowGid;
        }
        try {
          fs.writeFileSync(
            CONFIG_FILE_PATH,
            JSON.stringify({ runtimeGitLabConfig, lastParsedCurl }, null, 2),
            "utf8"
          );
          console.log(`[server] Saved new workflowId ${workflowGid} for key ${conversationKey} to runtime-config.json`);
        } catch (err) {
          console.error("Gagal menyimpan workflowId ke disk:", err.message);
        }
      }
    }
  });

  try {
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      for await (const delta of duo.streamChat({ prompt, messages })) {
        writeSse(res, sseChunk({ model, content: delta }));
      }

      writeSse(res, sseChunk({ model, finishReason: "stop" }));
      writeSseDone(res);
      res.end();
      return;
    }

    const content = await duo.completeChat({ prompt, messages });
    res.json(completionResponse({ model, content }));
  } catch (err) {
    if (res.headersSent) {
      writeSse(
        res,
        sseChunk({
          model,
          content: `\n[GitLab Duo adapter error: ${err.message}]`,
        }),
      );
      writeSseDone(res);
      res.end();
      return;
    }

    res.status(502).json({
      error: {
        message: err.message,
        type: "gitlab_duo_adapter_error",
      },
    });
  }
});

app.listen(config.port, () => {
  console.log(
    `GitLab Duo OpenAI-compatible adapter running on port ${config.port}`,
  );
  console.log(
    `Open http://localhost:${config.port}/ and paste the full GitLab Duo WebSocket curl.`,
  );
});

function renderHomePage({
  wsConfigured = false,
  graphqlConfigured = false,
  parsed,
  apiKey,
  modelId,
  message = "",
  error = "",
}) {
  // Backwards compatibility if called with "configured" instead of "wsConfigured"
  const isWsActive = wsConfigured;
  const isGqlActive = graphqlConfigured;
  const namespaceId = runtimeGitLabConfig.graphql?.namespaceId || "";

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GitLab Duo Adapter Console</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Outfit:wght@500;600;700;800&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #070a13;
      --panel-bg: rgba(13, 20, 38, 0.75);
      --border-color: rgba(255, 255, 255, 0.08);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #7dd3fc;
      --primary-glow: rgba(56, 189, 248, 0.2);
      --secondary: #818cf8;
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.2);
      --danger: #ef4444;
      --danger-glow: rgba(239, 68, 68, 0.2);
    }
    
    * {
      box-sizing: border-box;
      transition: all 0.2s ease-in-out;
    }
    
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: radial-gradient(circle at 10% 20%, rgba(99, 102, 241, 0.15) 0%, transparent 40%),
                  radial-gradient(circle at 90% 80%, rgba(56, 189, 248, 0.15) 0%, transparent 40%),
                  var(--bg-dark);
      color: var(--text-main);
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 24px;
    }
    
    main {
      width: min(960px, calc(100vw - 32px));
      position: relative;
    }
    
    /* Ambient glow behind card */
    .glow-bg {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 80%;
      height: 80%;
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.15), rgba(129, 140, 248, 0.15));
      filter: blur(120px);
      z-index: -1;
      border-radius: 40px;
    }
    
    .card {
      background: var(--panel-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 36px;
      box-shadow: 0 25px 80px -10px rgba(0, 0, 0, 0.6);
    }
    
    h1 {
      margin: 0 0 12px;
      font-family: 'Outfit', sans-serif;
      font-size: 32px;
      font-weight: 800;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }
    
    p {
      color: var(--text-muted);
      line-height: 1.6;
      font-size: 15px;
      margin-top: 0;
      margin-bottom: 24px;
    }
    
    /* Status Panel */
    .status-panel {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 28px;
      padding: 16px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 16px;
    }
    
    .status-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border-color);
      font-size: 14px;
      font-weight: 500;
    }
    
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    
    .status-dot.active {
      background-color: var(--success);
      box-shadow: 0 0 10px var(--success);
      animation: pulse 1.8s infinite;
    }
    
    .status-dot.inactive {
      background-color: var(--danger);
      box-shadow: 0 0 10px var(--danger);
    }
    
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
    
    textarea {
      width: 100%;
      min-height: 200px;
      resize: vertical;
      box-sizing: border-box;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(0, 0, 0, 0.35);
      color: #e2e8f0;
      padding: 16px;
      font-family: 'Fira Code', ui-monospace, monospace;
      font-size: 13px;
      line-height: 1.5;
      outline: none;
    }
    
    textarea:focus {
      border-color: var(--primary);
      box-shadow: 0 0 16px var(--primary-glow);
    }
    
    button {
      margin-top: 18px;
      border: 0;
      border-radius: 12px;
      padding: 14px 28px;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      color: #041026;
      font-family: 'Outfit', sans-serif;
      font-weight: 700;
      font-size: 15px;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(56, 189, 248, 0.2);
    }
    
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(56, 189, 248, 0.35);
      filter: brightness(1.1);
    }
    
    button:active {
      transform: translateY(0);
    }
    
    code, pre {
      font-family: 'Fira Code', ui-monospace, monospace;
    }
    
    pre {
      white-space: pre-wrap;
      word-break: break-all;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 18px;
      color: #cbd5e1;
      font-size: 12.5px;
      line-height: 1.5;
    }
    
    .ok {
      background: rgba(16, 185, 129, 0.1);
      border-left: 4px solid var(--success);
      padding: 12px 18px;
      border-radius: 8px;
      color: #a7f3d0;
      margin-bottom: 24px;
      font-size: 14px;
    }
    
    .err {
      background: rgba(239, 68, 68, 0.1);
      border-left: 4px solid var(--danger);
      padding: 12px 18px;
      border-radius: 8px;
      color: #fca5a5;
      margin-bottom: 24px;
      font-size: 14px;
    }
    
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-top: 32px;
    }
    
    h2 {
      font-family: 'Outfit', sans-serif;
      font-size: 18px;
      margin-top: 0;
      margin-bottom: 12px;
      color: var(--primary);
    }
    
    @media (max-width: 800px) {
      .grid { grid-template-columns: 1fr; }
      .card { padding: 24px; }
    }
  </style>
</head>
<body>
  <main>
    <div class="glow-bg"></div>
    <div class="card">
      <h1>GitLab Duo Adapter Console</h1>
      <p>Paste isi berkas <code>.har</code> (HTTP Archive JSON) atau perintah <code>curl</code> WebSocket & GraphQL dari GitLab DevTools ke textarea di bawah untuk menyinkronkan autentikasi sesi Anda secara otomatis.</p>
      
      ${message ? `<div class="ok">${escapeHtml(message)}</div>` : ""}
      ${error ? `<div class="err"><strong>Error:</strong> ${escapeHtml(error)}</div>` : ""}
      
      <div class="status-panel">
        <div class="status-item">
          <span class="status-dot ${isWsActive ? 'active' : 'inactive'}"></span>
          <span>WebSocket: <strong>${isWsActive ? 'Configured' : 'Missing'}</strong></span>
        </div>
        <div class="status-item">
          <span class="status-dot ${isGqlActive ? 'active' : 'inactive'}"></span>
          <span>GraphQL API: <strong>${isGqlActive ? 'Configured' : 'Missing'}</strong></span>
        </div>
        ${namespaceId ? `
        <div class="status-item">
          <span>Namespace GID: <code style="color:var(--primary);">${escapeHtml(namespaceId)}</code></span>
        </div>` : ""}
      </div>
      
      <form method="post" action="/configure">
        <textarea name="curl" spellcheck="false" placeholder="Contoh paste isi berkas .har:&#10;{&#10;  &quot;log&quot;: {&#10;    &quot;entries&quot;: [...]&#10;  }&#10;}&#10;&#10;Atau paste perintah curl:&#10;curl 'https://gitlab.com/api/graphql' ...&#10;curl 'wss://gitlab.com/api/v4/ai/duo_workflows/ws' ..."></textarea>
        <button type="submit">Simpan Konfigurasi</button>
      </form>
      
      <div class="grid">
        <section>
          <h2>Active Status</h2>
          <pre>${escapeHtml(JSON.stringify({ 
            wsConfigured: isWsActive, 
            graphqlConfigured: isGqlActive,
            modelId, 
            apiKey 
          }, null, 2))}</pre>
        </section>
        <section>
          <h2>Last Parsed Config</h2>
          <pre>${escapeHtml(JSON.stringify(parsed || null, null, 2))}</pre>
        </section>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function extractModelIdentifier(wsUrl) {
  try {
    return (
      new URL(wsUrl).searchParams.get("user_selected_model_identifier") || ""
    );
  } catch {
    return "";
  }
}

function extractNamespaceId(wsUrl) {
  try {
    const rawId = new URL(wsUrl).searchParams.get("namespace_id") || "";
    if (/^\d+$/.test(rawId)) {
      return `gid://gitlab/Group/${rawId}`;
    }
    return rawId;
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
