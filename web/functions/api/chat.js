const DEFAULT_DOC_KEY = "GLM.md";
const DEFAULT_GLM_MODEL = "glm-4.6v-flashx";
const DEFAULT_GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const MODEL_REGISTRY = {
  "glm-4.6v-flashx": { provider: "glm", model: "glm-4.6v-flashx" },
  "gemini-3-flash-preview": { provider: "gemini", model: "gemini-3-flash-preview" },
};

function buildSystemPrompt(activeTab) {
  const tabHint = activeTab ? `?????????????${activeTab}?` : "";
  return [
    "?? IFRS17 ????????????????",
    tabHint,
    "?????????????????????????????????????????????????",
    "???????????????????",
    "?????????????????????????????",
    "?????????????????????????????????????",
    "????????????????????????",
    "?????????????????????????????",
    "????????? XXX0 ?? 0 ??? XXX?XXX1 ?? Y1 ? XXX?XXX2 ?? Y2 ? XXX??????",
    "????????????????????????",
  ].filter(Boolean).join(" ");
}

async function loadKnowledge(env) {
  const bucket = env.IFRS17_DOC_BUCKET;
  if (!bucket || typeof bucket.get !== "function") {
    throw new Error("R2 文档桶未绑定：请配置 IFRS17_DOC_BUCKET");
  }

  const key = env.IFRS17_DOC_KEY || DEFAULT_DOC_KEY;
  const object = await bucket.get(key);
  if (!object) {
    throw new Error(`R2 中未找到知识文档：${key}`);
  }

  return object.text();
}

function normalizeMessages(messages) {
  return Array.isArray(messages)
    ? messages
        .filter((message) => message && typeof message.content === "string")
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content.trim(),
        }))
        .filter((message) => message.content)
    : [];
}

function buildSystemContexts(activeTab, knowledge, traceContext) {
  const contexts = [
    { role: "system", content: buildSystemPrompt(activeTab) },
    {
      role: "system",
      content: `以下是系统当前版本的 IFRS17 引擎知识文档，请严格以此为准回答问题：\n\n${knowledge}`,
    },
  ];

  if (traceContext) {
    contexts.push({
      role: "system",
      content: `以下是系统基于当前活动情景生成的数字追溯与公式关联上下文，请优先依据它回答具体数字来源问题：\n\n${traceContext}`,
    });
  }

  return contexts;
}

function resolveModel(selectedModel, env) {
  const registryEntry = MODEL_REGISTRY[selectedModel] || MODEL_REGISTRY[DEFAULT_GLM_MODEL];
  if (registryEntry.provider === "gemini") {
    return {
      provider: "gemini",
      model: env.GEMINI_MODEL || registryEntry.model || DEFAULT_GEMINI_MODEL,
    };
  }
  return {
    provider: "glm",
    model: env.GLM_MODEL || registryEntry.model || DEFAULT_GLM_MODEL,
  };
}

function extractGlmReply(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractGeminiReply(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function toGeminiContents(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
}

function timeoutMessage(label) {
  return `试验版本使用${label}，大模型偶尔返回超时，请再试一次。`;
}

async function callGlm(env, model, messages) {
  if (!env.GLM_API_KEY) {
    throw new Error("服务端未配置 GLM_API_KEY");
  }

  let response;
  try {
    response = await fetch(env.GLM_API_URL || DEFAULT_GLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.GLM_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        top_p: 0.7,
        messages,
      }),
    });
  } catch {
    throw new Error(timeoutMessage("GLM-4.6V-FlashX"));
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const rawError = payload?.error?.message || payload?.message || `GLM 调用失败：${response.status}`;
    const errorMessage = /timeout|timed out|deadline|network|fetch/i.test(String(rawError))
      ? timeoutMessage("GLM-4.6V-FlashX")
      : rawError;
    throw new Error(errorMessage);
  }

  return extractGlmReply(payload) || "当前没有拿到有效回复。";
}

async function callGemini(env, model, systemContexts, messages) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("服务端未配置 GEMINI_API_KEY");
  }

  const baseUrl = (env.GEMINI_API_URL || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, "");
  const systemText = systemContexts.map((message) => message.content).join("\n\n");

  let response;
  try {
    response = await fetch(`${baseUrl}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.2,
          topP: 0.7,
        },
        systemInstruction: {
          role: "system",
          parts: [{ text: systemText }],
        },
        contents: toGeminiContents(messages),
      }),
    });
  } catch {
    throw new Error(timeoutMessage("Gemini 3 Flash Preview"));
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const rawError = payload?.error?.message || payload?.message || `Gemini 调用失败：${response.status}`;
    const errorMessage = /timeout|timed out|deadline|network|fetch/i.test(String(rawError))
      ? timeoutMessage("Gemini 3 Flash Preview")
      : rawError;
    throw new Error(errorMessage);
  }

  return extractGeminiReply(payload) || "当前没有拿到有效回复。";
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json();
    const activeTab = body?.activeTab || "";
    const traceContext = typeof body?.traceContext === "string" ? body.traceContext.trim() : "";
    const selectedModel = typeof body?.selectedModel === "string" ? body.selectedModel.trim() : DEFAULT_GLM_MODEL;
    const messages = normalizeMessages(body?.messages);

    if (!messages.length) {
      return Response.json({ error: "消息为空" }, { status: 400 });
    }

    const knowledge = await loadKnowledge(env);
    const systemContexts = buildSystemContexts(activeTab, knowledge, traceContext);
    const runtime = resolveModel(selectedModel, env);
    const conversation = [...messages.slice(-12)];

    const reply = runtime.provider === "gemini"
      ? await callGemini(env, runtime.model, systemContexts, conversation)
      : await callGlm(env, runtime.model, [...systemContexts, ...conversation]);

    return Response.json({ reply });
  } catch (error) {
    return Response.json({ error: error?.message || "服务端处理失败" }, { status: 500 });
  }
}