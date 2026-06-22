const CHECKPOINT_QUERY = `query getWorkflowLatestCheckpoint($workflowId: AiDuoWorkflowsWorkflowID!) {
  duoWorkflowWorkflows(workflowId: $workflowId) {
    nodes {
      id
      status
      latestCheckpoint {
        workflowGoal
        workflowStatus
        errors
        duoMessages {
          content
          messageType
          messageSubType
          status
          timestamp
          correlationId
          messageId
          role
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

export class GitLabCheckpointClient {
  constructor(options = {}) {
    this.options = options || {};
  }

  isConfigured() {
    return Boolean(this.options.graphqlUrl && this.options.workflowId);
  }

  async latestAssistantContent() {
    if (!this.isConfigured()) return "";

    const safeHeaders = sanitizeHeaders(this.options.headers);

    const response = await fetch(this.options.graphqlUrl, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        ...safeHeaders,
      },
      body: JSON.stringify({
        operationName: "getWorkflowLatestCheckpoint",
        variables: { workflowId: this.options.workflowId },
        query: CHECKPOINT_QUERY,
      }),
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `GitLab returned HTTP ${response.status} Redirect. Sesi Anda (Cookie/Token) di neo.har kemungkinan sudah kadaluarsa (expired). Silakan ekspor ulang berkas .har yang baru dari browser Anda.`
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitLab GraphQL checkpoint failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `GitLab GraphQL checkpoint returned non-JSON: ${text.slice(0, 500)}`,
      );
    }

    if (data.errors?.length) {
      throw new Error(
        `GitLab GraphQL checkpoint errors: ${JSON.stringify(data.errors).slice(0, 1000)}`,
      );
    }

    const messages =
      data?.data?.duoWorkflowWorkflows?.nodes?.[0]?.latestCheckpoint
        ?.duoMessages || [];
    return latestAssistantMessage(messages)?.content || "";
  }
}

function latestAssistantMessage(messages) {
  const candidates = messages.filter((message) => {
    const role = String(message.role || "").toLowerCase();
    const type = String(message.messageType || "").toLowerCase();
    const subtype = String(message.messageSubType || "").toLowerCase();
    const content =
      typeof message.content === "string" ? message.content.trim() : "";

    if (!content) return false;
    if (role.includes("user") || type.includes("user")) return false;
    if (subtype.includes("tool") || type.includes("tool")) return false;
    if (role.includes("assistant")) return true;
    if (role.includes("agent")) return true;
    if (type.includes("assistant")) return true;
    if (type.includes("agent")) return true;

    // Fallback: Duo sometimes stores assistant-visible text with non-obvious enum names.
    return !role && !type;
  });

  return candidates.at(-1) || null;
}

function sanitizeHeaders(headers) {
  if (!headers) return {};
  const result = {};
  const skip = new Set([
    "content-length",
    "transfer-encoding",
    "connection",
    "host",
  ]);
  for (const [key, value] of Object.entries(headers)) {
    if (!skip.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}
