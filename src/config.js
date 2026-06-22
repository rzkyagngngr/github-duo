export const config = {
  port: Number(process.env.PORT || 3000),
  adapterApiKey: process.env.ADAPTER_API_KEY || "sk-rizky",

  modelId: process.env.MODEL_ID || "gitlab-duo-claude-opus-4-8-bedrock",

  gitlab: {
    wsUrl: "",
    headers: {},
    graphql: null,
    origin: "https://gitlab.com",
    protocol: "",
    connectTimeoutMs: Number(process.env.GITLAB_CONNECT_TIMEOUT_MS || 15000),
    responseTimeoutMs: Number(process.env.GITLAB_RESPONSE_TIMEOUT_MS || 20000),
    checkpointPollTimeoutMs: Number(
      process.env.GITLAB_CHECKPOINT_POLL_TIMEOUT_MS || 6000,
    ),
    checkpointPollIntervalMs: Number(
      process.env.GITLAB_CHECKPOINT_POLL_INTERVAL_MS || 1000,
    ),
    debugFrames: true,

    // Optional raw JSON templates used while the Duo frame protocol is still unknown.
    // Template variables: {{prompt}}, {{messagesJson}}, {{conversationId}}
    startFrameTemplate: process.env.GITLAB_DUO_START_FRAME_TEMPLATE || "",
    endFrameTemplate: process.env.GITLAB_DUO_END_FRAME_TEMPLATE || "",
  },
};
