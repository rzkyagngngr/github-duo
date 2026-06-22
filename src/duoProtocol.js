import { EventEmitter } from "node:events";

export class DuoProtocol extends EventEmitter {
  constructor({
    startFrameTemplate = "",
    endFrameTemplate = "",
    debugFrames = false,
  } = {}) {
    super();
    this.startFrameTemplate = startFrameTemplate;
    this.endFrameTemplate = endFrameTemplate;
    this.debugFrames = debugFrames;
    this.seenText = "";
  }

  buildStartFrames({ prompt, messages, conversationId }) {
    if (this.startFrameTemplate) {
      return [
        renderTemplate(this.startFrameTemplate, {
          prompt,
          messages,
          conversationId,
        }),
      ];
    }

    return [
      JSON.stringify({
        startRequest: {
          workflowID: String(conversationId),
          clientVersion: "1.0",
          workflowDefinition: "chat",
          workflowMetadata: JSON.stringify({
            extended_logging: false,
            is_team_member: false,
            tool_approval_for_session_enabled: true,
          }),
          clientCapabilities: ["incremental_streaming", "web_search"],
          goal: prompt,
          approval: {},
          useOrbit: false,
          additional_context: [
            {
              category: "orbit_context",
              content: JSON.stringify({ orbit_enabled: false }),
              metadata: "{}",
            },
          ],
        },
      }),
    ];
  }

  buildEndFrames({ prompt, messages, conversationId }) {
    if (!this.endFrameTemplate) return [];
    return [
      renderTemplate(this.endFrameTemplate, {
        prompt,
        messages,
        conversationId,
      }),
    ];
  }

  parseFrame(rawFrame) {
    const text = bufferToText(rawFrame);

    if (this.debugFrames) {
      console.error("[gitlab-duo:ws:recv]", text);
    }

    const json = safeJsonParse(text);
    if (!json) {
      return { kind: "unknown", raw: text };
    }

    const error = pickFirstString(json, [
      "error",
      "error.message",
      "message.error",
      "payload.error",
      "payload.errors.0.message",
    ]);

    if (error) return { kind: "error", error, raw: json };

    const checkpointText = this.parseCheckpointText(json);
    if (checkpointText) {
      const delta = this.toDelta(checkpointText);
      return { kind: "delta", delta, fullText: checkpointText, raw: json };
    }

    const done = Boolean(
      json.done ||
      json.complete ||
      json.completed ||
      json.finished ||
      json.type === "done" ||
      json.type === "complete" ||
      json.event === "done" ||
      json.event === "complete",
    );

    const candidateText = pickFirstString(json, [
      "delta",
      "content",
      "text",
      "message",
      "message.content",
      "payload.delta",
      "payload.content",
      "payload.text",
      "payload.message.content",
      "data.delta",
      "data.content",
      "data.text",
      "data.message.content",
      "chunk.delta",
      "chunk.content",
    ]);

    if (candidateText) {
      const delta = this.toDelta(candidateText);
      return { kind: "delta", delta, fullText: candidateText, raw: json };
    }

    if (done) return { kind: "done", raw: json };

    return { kind: "json", raw: json };
  }

  parseCheckpointText(json) {
    const checkpoint = json?.newCheckpoint?.checkpoint;
    if (typeof checkpoint !== "string" || checkpoint.length === 0) return "";

    const parsed = safeJsonParse(checkpoint);
    const chatLog = parsed?.channel_values?.ui_chat_log;
    if (!Array.isArray(chatLog)) return "";

    const message = latestAssistantLikeMessageForCurrentTurn(chatLog);
    return message?.content || "";
  }

  toDelta(candidateText) {
    if (!candidateText.startsWith(this.seenText)) {
      this.seenText += candidateText;
      return candidateText;
    }

    const delta = candidateText.slice(this.seenText.length);
    this.seenText = candidateText;
    return delta;
  }
}

function latestAssistantLikeMessage(messages) {
  const candidates = messages.filter((message) => {
    const type = String(
      message.message_type || message.messageType || "",
    ).toLowerCase();
    const subtype = String(
      message.message_sub_type || message.messageSubType || "",
    ).toLowerCase();
    const status = String(message.status || "").toLowerCase();
    const content = typeof message.content === "string" ? message.content : "";

    if (!content.trim()) return false;
    if (
      status &&
      !["success", "done", "completed", "complete"].includes(status)
    )
      return false;
    if (type.includes("user") || subtype.includes("user")) return false;
    if (type.includes("tool") || subtype.includes("tool")) return false;
    if (type.includes("agent") || type.includes("assistant")) return true;

    return false;
  });

  return candidates.at(-1) || null;
}

function latestAssistantLikeMessageForCurrentTurn(messages) {
  // Find index of last user message
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const type = String(msg.message_type || msg.role || "").toLowerCase();
    if (type.includes("user")) {
      lastUserIndex = i;
      break;
    }
  }

  // Filter assistant messages that appear AFTER the last user message
  const candidates = messages.filter((message, index) => {
    if (index <= lastUserIndex) return false;

    const type = String(
      message.message_type || message.messageType || "",
    ).toLowerCase();
    const subtype = String(
      message.message_sub_type || message.messageSubType || "",
    ).toLowerCase();
    const status = String(message.status || "").toLowerCase();
    const content = typeof message.content === "string" ? message.content : "";

    if (!content.trim()) return false;
    if (
      status &&
      !["success", "done", "completed", "complete"].includes(status)
    )
      return false;
    if (type.includes("user") || subtype.includes("user")) return false;
    if (type.includes("tool") || subtype.includes("tool")) return false;
    if (type.includes("agent") || type.includes("assistant")) return true;

    return false;
  });

  return candidates.at(-1) || null;
}

function renderTemplate(template, { prompt, messages, conversationId }) {
  return template
    .replaceAll("{{prompt}}", JSON.stringify(prompt).slice(1, -1))
    .replaceAll("{{messagesJson}}", JSON.stringify(messages || []))
    .replaceAll("{{conversationId}}", conversationId || "");
}

function bufferToText(frame) {
  if (Buffer.isBuffer(frame)) return frame.toString("utf8");
  if (frame instanceof ArrayBuffer) return Buffer.from(frame).toString("utf8");
  return String(frame);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickFirstString(object, paths) {
  for (const path of paths) {
    const value = getPath(object, path);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function getPath(object, path) {
  return path.split(".").reduce((current, segment) => {
    if (current == null) return undefined;
    if (/^\d+$/.test(segment)) return current[Number(segment)];
    return current[segment];
  }, object);
}
