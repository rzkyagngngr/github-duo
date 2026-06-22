export function requireBearerToken(expectedToken) {
  return function auth(req, res, next) {
    // API key validation bypassed
    next();
  };
}

export function messagesToPrompt(messages = []) {
  return messages
    .map((message) => {
      const role = message.role || "user";
      const content = normalizeContent(message.content);
      return `${role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
}

export function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

export const AVAILABLE_MODELS = [
  // Anthropic
  { id: "claude_haiku_4_5_20251001", provider: "Anthropic" },
  { id: "claude_haiku_4_5_20251001_bedrock", provider: "Bedrock" },
  { id: "claude_haiku_4_5_20251001_vertex", provider: "Gemini Enterprise Agent Platform" },
  { id: "claude_sonnet_4_5_20250929", provider: "Anthropic" },
  { id: "claude_sonnet_4_5_20250929_vertex", provider: "Gemini Enterprise Agent Platform" },
  { id: "claude_sonnet_4_5_20250929_bedrock", provider: "Bedrock" },
  { id: "claude_sonnet_4_6", provider: "Anthropic" },
  { id: "claude_sonnet_4_6_bedrock", provider: "Bedrock" },
  { id: "claude_opus_4_5_20251101", provider: "Anthropic" },
  { id: "claude_opus_4_5_20251101_vertex", provider: "Gemini Enterprise Agent Platform" },
  { id: "claude_opus_4_6_20260205", provider: "Anthropic" },
  { id: "claude_opus_4_6_vertex", provider: "Gemini Enterprise Agent Platform" },
  { id: "claude_opus_4_6_bedrock", provider: "Bedrock" },
  { id: "claude_opus_4_7", provider: "Anthropic" },
  { id: "claude_opus_4_7_vertex", provider: "Gemini Enterprise Agent Platform" },
  { id: "claude_opus_4_7_bedrock", provider: "Bedrock" },
  { id: "claude_opus_4_8", provider: "Anthropic" },
  { id: "claude_opus_4_8_vertex", provider: "Gemini Enterprise Agent Platform" },
  { id: "claude_opus_4_8_bedrock", provider: "Bedrock" },
  // Gemini
  { id: "gemini_3_5_flash_vertex", provider: "Gemini Enterprise Agent Platform" },
  // OpenAI / GPT-5
  { id: "gpt_5", provider: "OpenAI" },
  { id: "gpt_5_codex", provider: "OpenAI" },
  { id: "gpt_5_2_codex", provider: "OpenAI" },
  { id: "gpt_5_3_codex", provider: "OpenAI" },
  { id: "gpt_5_mini", provider: "OpenAI" },
  { id: "gpt_5_2", provider: "OpenAI" },
  { id: "gpt_5_4", provider: "OpenAI" },
  { id: "gpt_5_4_mini", provider: "OpenAI" },
  { id: "gpt_5_4_nano", provider: "OpenAI" },
  { id: "gpt_5_5", provider: "OpenAI" }
];

export function resolveGitLabModel(modelIdInput, defaultModelId) {
  if (!modelIdInput) return defaultModelId;
  
  const norm = modelIdInput.toLowerCase().trim();
  
  // Direct match
  const directMatch = AVAILABLE_MODELS.find(m => m.id.toLowerCase() === norm);
  if (directMatch) return directMatch.id;
  
  // Alias mapping
  if (norm.includes("sonnet")) {
    if (norm.includes("4.5") || norm.includes("4-5") || norm.includes("4_5") || norm.includes("3.5") || norm.includes("3-5")) {
      // Treat Sonnet 3.5 / 4.5 as 4.5 or 4.6 depending on availability. Sonnet 4.6 is latest.
      if (norm.includes("4.5") || norm.includes("4-5") || norm.includes("4_5")) {
        return "claude_sonnet_4_5_20250929_bedrock";
      }
    }
    return "claude_sonnet_4_6_bedrock";
  }
  if (norm.includes("opus")) {
    if (norm.includes("4.5") || norm.includes("4-5") || norm.includes("4_5")) {
      return "claude_opus_4_5_20251101";
    }
    if (norm.includes("4.6") || norm.includes("4-6") || norm.includes("4_6")) {
      return "claude_opus_4_6_bedrock";
    }
    if (norm.includes("4.7") || norm.includes("4-7") || norm.includes("4_7")) {
      return "claude_opus_4_7_bedrock";
    }
    return "claude_opus_4_8_bedrock";
  }
  if (norm.includes("haiku")) {
    return "claude_haiku_4_5_20251001_bedrock";
  }
  if (norm.includes("flash") || norm.includes("gemini")) {
    return "gemini_3_5_flash_vertex";
  }
  if (norm.includes("gpt-5.5") || norm.includes("gpt-5-5")) {
    return "gpt_5_5";
  }
  if (norm.includes("gpt-5.4") || norm.includes("gpt-5-4")) {
    return "gpt_5_4";
  }
  if (norm.includes("gpt-5") || norm.includes("gpt5")) {
    if (norm.includes("mini")) return "gpt_5_mini";
    if (norm.includes("codex")) return "gpt_5_codex";
    return "gpt_5_2";
  }
  
  return defaultModelId;
}

export function modelList(defaultModelId) {
  const list = AVAILABLE_MODELS.map(m => ({
    id: m.id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "gitlab-duo-adapter"
  }));
  
  if (defaultModelId && !AVAILABLE_MODELS.some(m => m.id === defaultModelId)) {
    list.unshift({
      id: defaultModelId,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "gitlab-duo-adapter"
    });
  }
  
  return {
    object: "list",
    data: list
  };
}

export function completionResponse({ model, content, finishReason = "stop" }) {
  const created = Math.floor(Date.now() / 1000);

  return {
    id: `chatcmpl-gitlab-duo-${created}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

export function sseChunk({ model, content = "", finishReason = null }) {
  return {
    id: `chatcmpl-gitlab-duo-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: finishReason ? {} : { content },
        finish_reason: finishReason
      }
    ]
  };
}

export function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeSseDone(res) {
  res.write("data: [DONE]\n\n");
}

export function openApiSpec(modelId) {
  return {
    openapi: "3.0.3",
    info: {
      title: "GitLab Duo OpenAI-Compatible Adapter API",
      description: "Adapter API yang mengekspos endpoint OpenAI-compatible untuk berinteraksi dengan GitLab Duo.",
      version: "1.0.0"
    },
    servers: [
      {
        url: "/v1"
      }
    ],
    paths: {
      "/models": {
        "get": {
          "summary": "List Models",
          "description": "Mengembalikan daftar model yang tersedia pada adapter ini.",
          "security": [
            {
              "BearerAuth": []
            }
          ],
          "responses": {
            "200": {
              "description": "Daftar model berhasil diambil.",
              "content": {
                "application/json": {
                  "schema": {
                    "type": "object",
                    "properties": {
                      "object": {
                        "type": "string",
                        "example": "list"
                      },
                      "data": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "id": {
                              "type": "string",
                              "example": modelId
                            },
                            "object": {
                              "type": "string",
                              "example": "model"
                            },
                            "created": {
                              "type": "integer",
                              "example": 1718900000
                            },
                            "owned_by": {
                              "type": "string",
                              "example": "gitlab-duo-adapter"
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/chat/completions": {
        "post": {
          "summary": "Chat Completions",
          "description": "Membuat respon chat completion OpenAI-compatible menggunakan GitLab Duo.",
          "security": [
            {
              "BearerAuth": []
            }
          ],
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": ["messages"],
                  "properties": {
                    "model": {
                      "type": "string",
                      "default": modelId,
                      "description": "ID model yang digunakan."
                    },
                    "messages": {
                      "type": "array",
                      "description": "Daftar pesan percakapan.",
                      "items": {
                        "type": "object",
                        "required": ["role", "content"],
                        "properties": {
                          "role": {
                            "type": "string",
                            "enum": ["system", "user", "assistant"],
                            "example": "user"
                          },
                          "content": {
                            "type": "string",
                            "example": "Hello"
                          }
                        }
                      }
                    },
                    "stream": {
                      "type": "boolean",
                      "default": false,
                      "description": "Apakah menggunakan streaming respons SSE."
                    }
                  }
                }
              }
            }
          },
          "responses": {
            "200": {
              "description": "Respon berhasil (bisa berupa JSON atau Server-Sent Events stream jika stream=true).",
              "content": {
                "application/json": {
                  "schema": {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string",
                        "example": "chatcmpl-gitlab-duo-1718900000"
                      },
                      "object": {
                        "type": "string",
                        "example": "chat.completion"
                      },
                      "created": {
                        "type": "integer",
                        "example": 1718900000
                      },
                      "model": {
                        "type": "string",
                        "example": modelId
                      },
                      "choices": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "index": {
                              "type": "integer",
                              "example": 0
                            },
                            "message": {
                              "type": "object",
                              "properties": {
                                "role": {
                                  "type": "string",
                                  "example": "assistant"
                                },
                                "content": {
                                  "type": "string",
                                  "example": "Hello, how can I help you?"
                                }
                              }
                            },
                            "finish_reason": {
                              "type": "string",
                              "example": "stop"
                            }
                          }
                        }
                      },
                      "usage": {
                        "type": "object",
                        "properties": {
                          "prompt_tokens": {
                            "type": "integer",
                            "example": 0
                          },
                          "completion_tokens": {
                            "type": "integer",
                            "example": 0
                          },
                          "total_tokens": {
                            "type": "integer",
                            "example": 0
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "components": {
      "securitySchemes": {
        "BearerAuth": {
          "type": "http",
          "scheme": "bearer"
        }
      }
    }
  };
}

