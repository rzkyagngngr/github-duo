import WebSocket from "ws";
import { DuoProtocol } from "./duoProtocol.js";
import { GitLabCheckpointClient } from "./checkpointClient.js";
import { GitLabWorkflowCreator } from "./workflowCreator.js";

export class GitLabDuoClient {
  constructor(options) {
    this.options = options;
  }

  async *streamChat({ prompt, messages }) {
    if (!this.options.graphql?.graphqlUrl) {
      throw new Error(
        "GraphQL curl belum dikonfigurasi (dibutuhkan untuk aiDuoWorkflowCreate)",
      );
    }

    const errors = [];

    // Primary strategy: WebSocket approach (if wsUrl configured)
    if (this.options.wsUrl || this.options.wsTemplate) {
      try {
        let yielded = false;
        const baselineCheckpointContent = await this.tryReadCheckpointFallback();
        for await (const delta of this.streamAttempt({
          prompt,
          messages,
          baselineCheckpointContent,
        })) {
          yielded = true;
          yield delta;
        }
        if (yielded) return;
      } catch (err) {
        errors.push(`WebSocket: ${err.message}`);
        if (this.options.debugFrames) {
          console.error("[gitlab-duo:ws:error]", err.message);
          if (err.cause) console.error("[gitlab-duo:ws:cause]", err.cause?.message ?? String(err.cause));
        }
      }
    }

    // Fallback strategy: GraphQL workflow + aiAction + checkpoint polling
    try {
      let yielded = false;
      for await (const delta of this.streamViaGraphQL({ prompt, messages })) {
        yielded = true;
        yield delta;
      }
      if (yielded) return;
    } catch (err) {
      errors.push(`GraphQL: ${err.message}`);
      if (this.options.debugFrames) {
        console.error("[gitlab-duo:graphql:error]", err.message);
        if (err.cause) console.error("[gitlab-duo:graphql:cause]", err.cause?.message ?? String(err.cause));
      }
    }

    throw new Error(`GitLab Duo stream failed. ${errors.join(" | ")}`);
  }

  /**
   * Primary streaming approach:
   * 1. Create workflow via aiDuoWorkflowCreate
   * 2. Send user message via aiAction (triggers AI processing)
   * 3. Poll checkpoint via GraphQL for AI response
   */
  async *streamViaGraphQL({ prompt, messages }) {
    const creator = new GitLabWorkflowCreator(this.options.graphql);

    const hasAssistantMessage = messages?.some(m => m.role === "assistant" || m.role === "agent");
    const lastUserMsg = messages?.filter(m => m.role === "user").at(-1)?.content || prompt;

    let created;
    if (messages && hasAssistantMessage && this.options.graphql?.workflowId) {
      const existingId = this.options.graphql.workflowId;
      created = {
        workflowGid: existingId,
        numericId: existingId.split("/").pop(),
        modelIdentifier: this.options.modelIdentifier,
      };
      if (this.options.debugFrames) {
        console.error(
          "[gitlab-duo:workflow:graphql] Reusing existing workflow:",
          created.workflowGid,
        );
      }
    } else {
      if (this.options.debugFrames) {
        console.error("[gitlab-duo:graphql] Creating new workflow...");
      }

      created = await creator.createChatWorkflow({
        goal: lastUserMsg,
        modelIdentifier: this.options.modelIdentifier,
      });

      if (this.options.onWorkflowCreated) {
        this.options.onWorkflowCreated(created.workflowGid);
      }

      if (this.options.debugFrames) {
        console.error(
          "[gitlab-duo:workflow:create:graphql]",
          created.workflowGid,
          created.numericId,
        );
      }
    }

    // Send user message to trigger AI processing
    if (this.options.debugFrames) {
      console.error("[gitlab-duo:graphql] Sending message via aiAction...");
    }

    const { requestId } = await creator.sendChatMessage({ content: lastUserMsg });

    if (this.options.debugFrames) {
      console.error("[gitlab-duo:graphql:aiAction] requestId:", requestId);
    }

    // Poll checkpoint for AI response
    const checkpoint = new GitLabCheckpointClient({
      ...this.options.graphql,
      workflowId: created.workflowGid,
    });

    const deadline =
      Date.now() + Number(this.options.responseTimeoutMs || 60000);
    const pollInterval = Number(this.options.checkpointPollIntervalMs || 1500);
    let lastContent = "";
    let yielded = false;

    while (Date.now() < deadline) {
      await delay(pollInterval);

      let content = "";
      try {
        content = await checkpoint.latestAssistantContent();
      } catch (err) {
        if (this.options.debugFrames) {
          console.error("[gitlab-duo:checkpoint:poll:error]", err.message);
        }
        continue;
      }

      if (this.options.debugFrames && content !== lastContent) {
        console.error(
          "[gitlab-duo:checkpoint:poll] content length:",
          content.length,
          "lastContent length:",
          lastContent.length,
        );
      }

      if (content && content !== lastContent) {
        // Yield the delta (new content since last poll)
        if (content.startsWith(lastContent)) {
          const delta = content.slice(lastContent.length);
          if (delta) {
            yield delta;
            yielded = true;
          }
        } else {
          // Content changed completely, yield all of it
          yield content;
          yielded = true;
        }
        lastContent = content;
      }

      // Check if workflow is done (status changed to completed)
      const workflowDone = await this.isWorkflowDone(created.workflowGid);
      if (workflowDone && content) {
        if (this.options.debugFrames) {
          console.error("[gitlab-duo:graphql] Workflow completed.");
        }
        return;
      }

      // If we've received content and had a stable period, consider done
      if (yielded) {
        const stableWait = pollInterval * 2;
        await delay(stableWait);
        const contentAfterWait = await checkpoint.latestAssistantContent().catch(() => lastContent);
        if (contentAfterWait === lastContent) {
          // Content stable - done
          return;
        }
        if (contentAfterWait && contentAfterWait !== lastContent) {
          const delta = contentAfterWait.startsWith(lastContent)
            ? contentAfterWait.slice(lastContent.length)
            : contentAfterWait;
          if (delta) yield delta;
          lastContent = contentAfterWait;
        }
        return;
      }
    }

    if (!yielded) {
      throw new Error(
        `GitLab Duo checkpoint polling timeout after ${Math.round((this.options.responseTimeoutMs || 60000) / 1000)}s — no assistant response found.`,
      );
    }
  }

  async isWorkflowDone(workflowGid) {
    const WORKFLOW_STATUS_QUERY = `query getWorkflowStatus($workflowId: AiDuoWorkflowsWorkflowID!) {
      duoWorkflowWorkflows(workflowId: $workflowId) {
        nodes { id status }
      }
    }`;

    try {
      const safeHeaders = sanitizeHeaders(this.options.graphql?.headers);
      const res = await fetch(this.options.graphql?.graphqlUrl, {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          ...safeHeaders,
        },
        body: JSON.stringify({
          query: WORKFLOW_STATUS_QUERY,
          variables: { workflowId: workflowGid },
        }),
      });
      const data = await res.json();
      const status = data?.data?.duoWorkflowWorkflows?.nodes?.[0]?.status || "";
      const doneStatuses = ["COMPLETED", "FAILED", "ARCHIVED", "INPUT_REQUIRED"];
      return doneStatuses.includes(status.toUpperCase());
    } catch {
      return false;
    }
  }

  // ── WebSocket fallback (kept for compatibility) ──────────────────────────

  async *streamAttempt({ prompt, messages, baselineCheckpointContent }) {
    const creator = new GitLabWorkflowCreator(this.options.graphql);

    // Extract last user message as the current goal
    const lastUserMsg = messages?.filter(m => m.role === "user").at(-1)?.content || prompt;

    const hasAssistantMessage = messages?.some(m => m.role === "assistant" || m.role === "agent");
    let created;
    if (messages && hasAssistantMessage && this.options.graphql?.workflowId) {
      const existingId = this.options.graphql.workflowId;
      created = {
        workflowGid: existingId,
        numericId: existingId.split("/").pop(),
        modelIdentifier: this.options.modelIdentifier,
      };
      if (this.options.debugFrames) {
        console.error(
          "[gitlab-duo:workflow:ws] Reusing existing workflow:",
          created.workflowGid,
        );
      }
    } else {
      created = await creator.createChatWorkflow({
        goal: lastUserMsg,
        modelIdentifier: this.options.modelIdentifier,
      });

      if (this.options.onWorkflowCreated) {
        this.options.onWorkflowCreated(created.workflowGid);
      }

      if (this.options.debugFrames) {
        console.error(
          "[gitlab-duo:workflow:create:ws]",
          created.workflowGid,
          created.numericId,
        );
      }
    }

    const { wsUrl, headers } = this.resolveWsUrl(created);
    if (!wsUrl) {
      throw new Error("WebSocket URL tidak bisa dibangun dari template");
    }

    const protocol = new DuoProtocol({
      startFrameTemplate: this.options.startFrameTemplate,
      endFrameTemplate: this.options.endFrameTemplate,
      debugFrames: this.options.debugFrames,
    });

    const ws = await this.openSocket(wsUrl, headers);

    // Send startRequest frame to trigger agent execution
    const startFrames = protocol.buildStartFrames({
      prompt: lastUserMsg,
      messages,
      conversationId: created.numericId,
    });
    for (const frame of startFrames) {
      if (this.options.debugFrames) {
        console.error("[gitlab-duo:ws:send]", frame);
      }
      ws.send(frame);
    }

    const queue = [];
    const recentEvents = [];
    let done = false;
    let error = null;
    let notify = null;
    let deltaCount = 0;
    let frameCount = 0;
    let closeCode = null;
    let closeReason = "";

    const wake = () => {
      if (notify) {
        notify();
        notify = null;
      }
    };

    const push = (item) => {
      queue.push(item);
      wake();
    };

    const closeTimer = setTimeout(() => {
      error = new Error("Timed out waiting for GitLab Duo response");
      tryClose(ws);
      wake();
    }, this.options.responseTimeoutMs);

    ws.on("message", (frame) => {
      frameCount += 1;
      const event = protocol.parseFrame(frame);
      rememberEvent(recentEvents, event);

      if (event.kind === "delta" && event.delta) {
        deltaCount += 1;
        push(event.delta);
      }
      if (event.kind === "error") {
        error = new Error(event.error);
        tryClose(ws);
      }
      if (event.kind === "done") tryClose(ws);
    });

    ws.on("error", (err) => {
      error = err;
      wake();
    });

    ws.on("close", (code, reason) => {
      closeCode = code;
      closeReason = reason?.toString?.() || "";
      done = true;
      clearTimeout(closeTimer);
      wake();
    });

    try {
      while (!done || queue.length > 0) {
        if (error) throw error;
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        await new Promise((resolve) => {
          notify = resolve;
        });
      }

      if (error) throw error;

      if (deltaCount === 0) {
        const checkpointContent = await this.waitForChangedCheckpoint(
          created,
          baselineCheckpointContent,
        );
        if (checkpointContent) {
          yield checkpointContent;
          return;
        }

        throw new Error(
          buildEmptyResponseMessage({
            frameCount,
            closeCode,
            closeReason,
            recentEvents,
          }),
        );
      }
    } finally {
      clearTimeout(closeTimer);
      tryClose(ws);
    }
  }

  resolveWsUrl(created) {
    const template = this.options.wsUrl || this.options.wsTemplate;
    if (!template) return { wsUrl: "", headers: this.options.headers || {} };

    const wsUrl = template.includes("{{workflow_id}}")
      ? template.replace(
          "{{workflow_id}}",
          encodeURIComponent(created.numericId),
        )
      : template;

    return { wsUrl, headers: this.options.headers || {} };
  }

  async waitForChangedCheckpoint(created, baselineContent) {
    const checkpoint = new GitLabCheckpointClient({
      ...this.options.graphql,
      workflowId: created.workflowGid,
    });
    if (!checkpoint.isConfigured()) return "";

    const deadline =
      Date.now() + Number(this.options.checkpointPollTimeoutMs || 20000);
    let lastContent = "";

    while (Date.now() < deadline) {
      await delay(Number(this.options.checkpointPollIntervalMs || 1500));
      lastContent = await this.readAssistantContent(checkpoint);
      if (lastContent && lastContent !== baselineContent) return lastContent;
    }

    return "";
  }

  async readAssistantContent(checkpoint) {
    try {
      return await checkpoint.latestAssistantContent();
    } catch (err) {
      if (this.options.debugFrames) {
        console.error("[gitlab-duo:checkpoint:poll:error]", err.message);
      }
      return "";
    }
  }

  async tryReadCheckpointFallback() {
    const checkpoint = new GitLabCheckpointClient(this.options.graphql);
    if (!checkpoint.isConfigured()) return "";

    try {
      const content = await checkpoint.latestAssistantContent();
      if (content && this.options.debugFrames) {
        console.error(
          "[gitlab-duo:checkpoint:fallback] assistant content found",
        );
      }
      return content;
    } catch (err) {
      if (this.options.debugFrames) {
        console.error("[gitlab-duo:checkpoint:fallback:error]", err.message);
        if (err.cause) console.error("[gitlab-duo:checkpoint:fallback:cause]", err.cause?.message ?? String(err.cause));
      }
      return "";
    }
  }

  async completeChat({ prompt, messages }) {
    let content = "";
    for await (const delta of this.streamChat({ prompt, messages })) {
      content += delta;
    }
    return content;
  }

  openSocket(wsUrl, wsHeaders) {
    const headers = {
      Accept: "*/*",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...sanitizeHeaders(wsHeaders || {}),
    };

    console.log("[gitlab-duo:openSocket] Connecting to:", wsUrl);
    console.log("[gitlab-duo:openSocket] Headers keys:", Object.keys(headers));
    console.log("[gitlab-duo:openSocket] connectTimeoutMs:", this.options.connectTimeoutMs);

    if (!headers.Origin && this.options.origin)
      headers.Origin = this.options.origin;

    const protocols = this.options.protocol
      ? [this.options.protocol]
      : undefined;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, protocols, {
        headers,
        perMessageDeflate: true,
        handshakeTimeout: this.options.connectTimeoutMs || 15000,
      });

      const timer = setTimeout(() => {
        tryClose(ws);
        reject(new Error("Timed out connecting to GitLab Duo WebSocket"));
      }, this.options.connectTimeoutMs || 15000);

      ws.once("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });

      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
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

function rememberEvent(recentEvents, event) {
  const raw = event.raw == null ? null : event.raw;
  recentEvents.push({ kind: event.kind, raw });
  if (recentEvents.length > 5) recentEvents.shift();
}

function buildEmptyResponseMessage({
  frameCount,
  closeCode,
  closeReason,
  recentEvents,
}) {
  const details = { frameCount, closeCode, closeReason, recentEvents };
  return `GitLab Duo WebSocket closed without assistant text. Diagnostics: ${JSON.stringify(details)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryClose(ws) {
  try {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close();
    }
  } catch {
    // Ignore close races.
  }
}
