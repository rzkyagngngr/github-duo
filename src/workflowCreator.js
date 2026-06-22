const CREATE_WORKFLOW_MUTATION = `mutation createAiDuoWorkflow(
  $projectId: ProjectID,
  $namespaceId: NamespaceID,
  $goal: String!,
  $workflowDefinition: String!,
  $agentPrivileges: [Int!],
  $preApprovedAgentPrivileges: [Int!],
  $allowAgentToRequestUser: Boolean,
  $aiCatalogItemVersionId: AiCatalogItemVersionID
) {
  aiDuoWorkflowCreate(
    input: {
      projectId: $projectId
      namespaceId: $namespaceId
      environment: WEB
      goal: $goal
      workflowDefinition: $workflowDefinition
      agentPrivileges: $agentPrivileges
      preApprovedAgentPrivileges: $preApprovedAgentPrivileges
      allowAgentToRequestUser: $allowAgentToRequestUser
      aiCatalogItemVersionId: $aiCatalogItemVersionId
    }
  ) {
    workflow {
      id
      __typename
    }
    errors
    __typename
  }
}`;

// Send user message to GitLab Duo AI via aiAction mutation.
// This triggers the AI to process and write a response to the workflow checkpoint.
const SEND_MESSAGE_MUTATION = `mutation sendDuoChatMessage($content: String!) {
  aiAction(input: {
    chat: {
      content: $content
      resourceId: null
    }
  }) {
    errors
    requestId
    __typename
  }
}`;

const DEFAULT_AGENT_PRIVILEGES = [2, 3, 7];
const DEFAULT_PRE_APPROVED_AGENT_PRIVILEGES = [2];

export class GitLabWorkflowCreator {
  constructor(options = {}) {
    this.options = options || {};
  }

  isConfigured() {
    return Boolean(this.options.graphqlUrl && this.options.headers);
  }

  buildWsUrl({ workflowId, wsTemplate }) {
    if (wsTemplate) {
      return wsTemplate.replace(
        "{{workflow_id}}",
        encodeURIComponent(workflowId),
      );
    }

    const template = this.options.wsTemplate;
    if (!template) return "";

    return template.replace("{{workflow_id}}", encodeURIComponent(workflowId));
  }

  async createChatWorkflow({ goal, modelIdentifier }) {
    if (!this.isConfigured()) {
      throw new Error(
        "GraphQL checkpoint curl belum dikonfigurasi. Paste curl api/graphql di halaman /.",
      );
    }

    // Strip Content-Length: HAR-captured value doesn't match our request body size
    const safeHeaders = sanitizeHeaders(this.options.headers);

    const response = await fetch(this.options.graphqlUrl, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        ...safeHeaders,
      },
      body: JSON.stringify({
        operationName: "createAiDuoWorkflow",
        variables: {
          projectId: null,
          namespaceId: this.options.namespaceId || null,
          goal,
          workflowDefinition: "chat",
          agentPrivileges: DEFAULT_AGENT_PRIVILEGES,
          preApprovedAgentPrivileges: DEFAULT_PRE_APPROVED_AGENT_PRIVILEGES,
          allowAgentToRequestUser: true,
          aiCatalogItemVersionId: null,
        },
        query: CREATE_WORKFLOW_MUTATION,
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
        `aiDuoWorkflowCreate failed (${response.status}): ${text.slice(0, 1000)}`,
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `aiDuoWorkflowCreate returned non-JSON: ${text.slice(0, 1000)}`,
      );
    }

    if (data.errors?.length) {
      throw new Error(
        `aiDuoWorkflowCreate errors: ${JSON.stringify(data.errors).slice(0, 2000)}`,
      );
    }

    const errors = data?.data?.aiDuoWorkflowCreate?.errors || [];
    if (errors.length) {
      throw new Error(
        `aiDuoWorkflowCreate errors: ${JSON.stringify(errors).slice(0, 2000)}`,
      );
    }

    const workflowId = data?.data?.aiDuoWorkflowCreate?.workflow?.id;
    if (!workflowId) {
      throw new Error(
        `aiDuoWorkflowCreate missing workflow id: ${text.slice(0, 1000)}`,
      );
    }

    return {
      workflowId,
      workflowGid: workflowId,
      numericId: workflowId.split("/").pop(),
      modelIdentifier,
    };
  }

  /**
   * Send user message via aiAction mutation.
   * This triggers GitLab Duo AI to process and write response to checkpoint.
   * Returns the requestId for tracking.
   */
  async sendChatMessage({ content }) {
    if (!this.isConfigured()) {
      throw new Error("GraphQL tidak dikonfigurasi.");
    }

    const safeHeaders = sanitizeHeaders(this.options.headers);

    const response = await fetch(this.options.graphqlUrl, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        ...safeHeaders,
      },
      body: JSON.stringify({
        operationName: "sendDuoChatMessage",
        variables: { content },
        query: SEND_MESSAGE_MUTATION,
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
        `aiAction sendChatMessage failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`aiAction returned non-JSON: ${text.slice(0, 500)}`);
    }

    if (data.errors?.length) {
      throw new Error(
        `aiAction errors: ${JSON.stringify(data.errors).slice(0, 1000)}`,
      );
    }

    const actionErrors = data?.data?.aiAction?.errors || [];
    if (actionErrors.length) {
      throw new Error(
        `aiAction errors: ${JSON.stringify(actionErrors).slice(0, 1000)}`,
      );
    }

    const requestId = data?.data?.aiAction?.requestId;
    return { requestId };
  }
}

/**
 * Remove headers that cause issues with Node.js built-in fetch:
 * - Content-Length: value from HAR doesn't match our request body
 * - Transfer-Encoding: managed automatically by fetch
 */
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
