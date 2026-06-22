export function requireBearerToken(expectedToken) {
  return function auth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.replace(/^Bearer\s+/i, "");

    if (token !== expectedToken) {
      return res.status(401).json({
        error: {
          message: "Invalid API key",
          type: "invalid_request_error"
        }
      });
    }

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

export function modelList(modelId) {
  return {
    object: "list",
    data: [
      {
        id: modelId,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "gitlab-duo-adapter"
      }
    ]
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

