const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "accept-encoding",
  "priority",
  "te",
]);

export function parsePosixCurl(input) {
  const parsed = parseDevtoolsCurls(input);
  if (parsed.ws) return parsed.ws;
  throw new Error(
    "URL WebSocket wss:// atau ws:// tidak ditemukan di command curl",
  );
}

export function parseDevtoolsCurls(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    return parseHar(trimmed);
  }

  const commands = splitCurlCommands(input);
  const parsed = {
    ws: null,
    graphql: null,
    parsedAt: new Date().toISOString(),
  };

  for (const command of commands) {
    const curl = parseSingleCurl(command);

    if (
      (curl.url.startsWith("wss://") || curl.url.startsWith("ws://")) &&
      !parsed.ws
    ) {
      parsed.ws = {
        wsUrl: curl.url,
        headers: curl.headers,
        parsedAt: parsed.parsedAt,
      };
      continue;
    }

    if (
      isGraphQLQuery(curl.url, curl.body) &&
      !parsed.graphql
    ) {
      parsed.graphql = {
        graphqlUrl: curl.url,
        headers: curl.headers,
        workflowId: extractWorkflowId(curl.body),
        namespaceId: extractNamespaceIdFromBody(curl.body),
        parsedAt: parsed.parsedAt,
      };
    }
  }

  if (!parsed.ws && !parsed.graphql) {
    throw new Error(
      "Tidak menemukan curl WebSocket GitLab Duo atau GraphQL api/graphql",
    );
  }

  if (parsed.ws && parsed.graphql && !parsed.graphql.workflowId) {
    parsed.graphql.workflowId = workflowGidFromWsUrl(parsed.ws.wsUrl);
  }

  return parsed;
}

export function redactParsedCurlConfig(config) {
  if (config?.ws || config?.graphql) {
    return {
      ws: config.ws ? redactOne(config.ws) : null,
      graphql: config.graphql ? redactOne(config.graphql) : null,
      parsedAt: config.parsedAt,
    };
  }

  return redactOne(config);
}

function redactOne(config) {
  const headers = { ...(config.headers || {}) };
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === "cookie") headers[name] = redactCookie(headers[name]);
    if (lower === "x-csrf-token") headers[name] = "<redacted>";
    if (lower === "authorization") headers[name] = "<redacted>";
  }

  return {
    ...config,
    headers,
  };
}

function parseSingleCurl(input) {
  const tokens = shellTokenize(input);
  if (tokens.length === 0 || tokens[0] !== "curl") {
    throw new Error(
      "Input harus berupa command curl POSIX yang dimulai dengan `curl`",
    );
  }

  let url = "";
  let body = "";
  const headers = {};

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "-H" || token === "--header") {
      const header = tokens[index + 1];
      if (!header)
        throw new Error("Header curl tidak lengkap setelah -H/--header");
      index += 1;

      const separator = header.indexOf(":");
      if (separator === -1) continue;

      const name = header.slice(0, separator).trim();
      const value = header.slice(separator + 1).trim();
      if (!name) continue;

      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
        headers[canonicalHeaderName(name)] = value;
      }
      continue;
    }

    if (token === "-A" || token === "--user-agent") {
      const value = tokens[index + 1];
      if (!value)
        throw new Error(
          "User-Agent curl tidak lengkap setelah -A/--user-agent",
        );
      headers["User-Agent"] = value;
      index += 1;
      continue;
    }

    if (["--data", "--data-raw", "--data-binary", "-d"].includes(token)) {
      const value = tokens[index + 1];
      if (!value) throw new Error(`Body curl tidak lengkap setelah ${token}`);
      body = value;
      index += 1;
      continue;
    }

    if (token.startsWith("-")) {
      continue;
    }

    if (!url) url = token;
  }

  if (!url) throw new Error("URL tidak ditemukan di command curl");
  return { url, headers, body };
}

function splitCurlCommands(input) {
  const normalized = input.replace(/\r\n/g, "\n");
  const starts = [];
  const regex = /(^|\n)\s*curl\s/g;
  let match;

  while ((match = regex.exec(normalized)) !== null) {
    starts.push(match.index + match[1].length);
  }

  if (starts.length === 0) return [input];

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? normalized.length;
    return normalized.slice(start, end).trim();
  });
}

function isGraphQLQuery(url, body) {
  if (!url.includes("/api/graphql")) return false;
  try {
    const parsedBody = JSON.parse(body);
    return Boolean(parsedBody.query || parsedBody.mutation || parsedBody.operationName);
  } catch {
    return body.includes("query") || body.includes("mutation") || body.includes("operationName");
  }
}

function extractNamespaceIdFromBody(body) {
  try {
    const data = JSON.parse(body);
    const id = data?.variables?.namespaceId || "";
    if (/^\d+$/.test(id)) {
      return `gid://gitlab/Group/${id}`;
    }
    return id;
  } catch {
    const match = body.match(/gid:\/\/gitlab\/(?:Group|Namespace|Project|User)\/\d+/);
    if (match) return match[0];

    // Check for "namespace_id": 1234 or similar in raw body
    const numMatch = body.match(/"namespace_?id"\s*:\s*(\d+|"[^"]+")/i);
    if (numMatch) {
      const rawId = numMatch[1].replace(/"/g, "");
      return /^\d+$/.test(rawId) ? `gid://gitlab/Group/${rawId}` : rawId;
    }
    return "";
  }
}

function extractNamespaceIdFromWsUrl(wsUrl) {
  try {
    const url = new URL(wsUrl);
    const rawId = url.searchParams.get("namespace_id") || url.searchParams.get("root_namespace_id") || "";
    if (rawId) {
      return /^\d+$/.test(rawId) ? `gid://gitlab/Group/${rawId}` : rawId;
    }
  } catch {}
  return "";
}

function extractWorkflowId(body) {
  try {
    const data = JSON.parse(body);
    return data?.variables?.workflowId || "";
  } catch {
    const match = body.match(/gid:\/\/gitlab\/Ai::DuoWorkflows::Workflow\/\d+/);
    return match?.[0] || "";
  }
}

function workflowGidFromWsUrl(wsUrl) {
  try {
    const url = new URL(wsUrl);
    const workflowId = url.searchParams.get("workflow_id");
    return workflowId
      ? `gid://gitlab/Ai::DuoWorkflows::Workflow/${workflowId}`
      : "";
  } catch {
    return "";
  }
}

function canonicalHeaderName(name) {
  const lower = name.toLowerCase();
  if (lower === "content-type") return "Content-Type";
  if (lower === "user-agent") return "User-Agent";
  if (lower === "x-csrf-token") return "x-csrf-token";
  if (lower === "origin") return "Origin";
  if (lower === "referer") return "Referer";
  if (lower === "cookie") return "Cookie";
  if (lower === "accept") return "Accept";
  if (lower === "accept-language") return "Accept-Language";
  return name;
}

function redactCookie(cookie) {
  return cookie
    .split(";")
    .map((part) => {
      const [name] = part.trim().split("=");
      return name ? `${name}=<redacted>` : "<redacted>";
    })
    .join("; ");
}

function shellTokenize(input) {
  const normalized = input.replace(/\\\r?\n/g, " ");
  const tokens = [];
  let current = "";
  let quote = null;
  let quoteMode = "normal";
  let escaped = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];

    if (!quote && char === "$" && normalized[index + 1] === "'") {
      quote = "'";
      quoteMode = "ansi";
      index += 1;
      continue;
    }

    if (escaped) {
      current += quoteMode === "ansi" ? decodeAnsiEscape(char) : char;
      escaped = false;
      continue;
    }

    if (char === "\\" && (quote !== "'" || quoteMode === "ansi")) {
      if (quoteMode === "ansi" && /[0-7]/.test(normalized[index + 1] || "")) {
        const octal =
          normalized.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] || "";
        current += String.fromCharCode(Number.parseInt(octal, 8));
        index += octal.length;
        continue;
      }
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
        quoteMode = "normal";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      quoteMode = "normal";
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error(`Quote ${quote} belum ditutup`);
  if (current.length > 0) tokens.push(current);

  return tokens;
}

function decodeAnsiEscape(char) {
  if (char === "n") return "\n";
  if (char === "r") return "\r";
  if (char === "t") return "\t";
  if (char === "b") return "\b";
  if (char === "f") return "\f";
  return char;
}

export function parseHar(input) {
  let har;
  try {
    har = JSON.parse(input);
  } catch (err) {
    throw new Error("Input diawali dengan '{' tetapi bukan format JSON HAR yang valid: " + err.message);
  }

  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) {
    throw new Error("Format HAR tidak valid (tidak menemukan log.entries)");
  }

  const parsed = {
    ws: null,
    graphql: null,
    parsedAt: new Date().toISOString(),
  };

  for (const entry of entries) {
    const url = entry?.request?.url || "";
    const method = entry?.request?.method || "";
    const headersArray = entry?.request?.headers || [];
    const postDataText = entry?.request?.postData?.text || "";
    const responseText = entry?.response?.content?.text || "";

    const headers = {};
    for (const h of headersArray) {
      const name = h.name;
      const value = h.value;
      if (name && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
        headers[canonicalHeaderName(name)] = value;
      }
    }

    // 1. WebSocket detection
    if (
      (url.startsWith("wss://") || url.startsWith("ws://") || url.includes("/api/v4/ai/duo_workflows/ws")) &&
      !parsed.ws
    ) {
      parsed.ws = {
        wsUrl: url,
        headers,
        parsedAt: parsed.parsedAt,
      };
    }

    // 2. GraphQL detection
    if (url.includes("/api/graphql") && method === "POST") {
      const isCreateWorkflow = postDataText.includes("createAiDuoWorkflow");
      const isLatestCheckpoint = postDataText.includes("getWorkflowLatestCheckpoint");

      if (isCreateWorkflow || isLatestCheckpoint || !parsed.graphql) {
        const namespaceId = extractNamespaceIdFromBody(postDataText);
        let workflowId = extractWorkflowId(postDataText);

        if (!workflowId && responseText) {
          workflowId = extractWorkflowId(responseText);
        }

        parsed.graphql = {
          graphqlUrl: url,
          headers,
          workflowId: workflowId || (parsed.graphql?.workflowId || ""),
          namespaceId: namespaceId || (parsed.graphql?.namespaceId || ""),
          parsedAt: parsed.parsedAt,
        };
      }
    }
  }

  if (!parsed.ws && !parsed.graphql) {
    throw new Error(
      "Tidak menemukan request WebSocket GitLab Duo maupun request GraphQL di dalam berkas HAR",
    );
  }

  if (parsed.ws && parsed.graphql && !parsed.graphql.workflowId) {
    parsed.graphql.workflowId = workflowGidFromWsUrl(parsed.ws.wsUrl);
  }

  // Fallback namespaceId from WebSocket or other entries if still empty
  if (parsed.graphql && !parsed.graphql.namespaceId) {
    let fallbackNamespaceId = "";
    if (parsed.ws) {
      fallbackNamespaceId = extractNamespaceIdFromWsUrl(parsed.ws.wsUrl);
    }
    
    if (!fallbackNamespaceId) {
      for (const entry of entries) {
        const url = entry?.request?.url || "";
        const postDataText = entry?.request?.postData?.text || "";
        
        // Check url query params
        try {
          const u = new URL(url);
          const ns = u.searchParams.get("namespace_id") || u.searchParams.get("root_namespace_id");
          if (ns) {
            fallbackNamespaceId = /^\d+$/.test(ns) ? `gid://gitlab/Group/${ns}` : ns;
            break;
          }
        } catch {}

        // Check referer header
        const referer = entry?.request?.headers?.find(h => h.name.toLowerCase() === "referer")?.value || "";
        if (referer) {
          try {
            const u = new URL(referer);
            const ns = u.searchParams.get("namespace_id") || u.searchParams.get("root_namespace_id");
            if (ns) {
              fallbackNamespaceId = /^\d+$/.test(ns) ? `gid://gitlab/Group/${ns}` : ns;
              break;
            }
          } catch {}
        }
        
        // Check post data
        if (postDataText) {
          const nsMatch = postDataText.match(/"namespace_?id"\s*:\s*(\d+|"[^"]+")/i);
          if (nsMatch) {
            const rawId = nsMatch[1].replace(/"/g, "");
            fallbackNamespaceId = `gid://gitlab/Group/${rawId}`;
            break;
          }
        }
      }
    }

    if (fallbackNamespaceId) {
      parsed.graphql.namespaceId = fallbackNamespaceId;
    }
  }

  return parsed;
}

