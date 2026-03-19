const DEFAULT_DOC_KEY = "GLM.md";
const DEFAULT_GLM_MODEL = "glm-4.6v-flashx";
const DEFAULT_GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_XIAOMI_MODEL = "MiMo-V2-Omni";
const DEFAULT_XIAOMI_URL = "https://api.xiaomimimo.com/v1/chat/completions";

const MODEL_REGISTRY = {
  "glm-4.6v-flashx": { provider: "glm", model: "glm-4.6v-flashx" },
  "gemini-3-flash-preview": { provider: "gemini", model: "gemini-3-flash-preview" },
  "mimo-v2-omni": { provider: "xiaomi", model: "MiMo-V2-Omni" },
};

function buildSystemPrompt(activeTab) {
  const tabHint = activeTab ? `当前用户停留页面：${activeTab}。` : "";
  return [
    "你是 IFRS17 财务影响测试平台的内置问答助手。",
    tabHint,
    "请优先根据系统提供的知识文档、数字追溯结果和关联数据回答问题，不要编造系统中不存在的逻辑。",
    "回答时先写结论，再补最必要的数据、原因或公式。",
    "如果用户问业务实质，就回答业务含义和影响。",
    "如果用户问数字原因，就回答该数字的来源、关键组成项和必要的中间值。",
    "如果用户问公式，就回答公式、变量含义和最关键的依赖项。",
    "如果问题超出当前文档或系统实现范围，请明确说明“当前文档/系统未定义”。",
    "命名约定：XXX0 表示 0 时点的 XXX；XXX1 表示 Y1 的 XXX；XXX2 表示 Y2 的 XXX；月度口径统一写作 M1、M2、M3。",
    "默认使用中文，回答尽量简短清晰。",
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
  if (registryEntry.provider === "xiaomi") {
    return {
      provider: "xiaomi",
      model: env.XIAOMI_MODEL || registryEntry.model || DEFAULT_XIAOMI_MODEL,
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

function isTransientError(rawError) {
  return /timeout|timed out|deadline|network|fetch|temporarily unavailable|temporarily overloaded/i.test(
    String(rawError || "")
  );
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
    throw new Error(isTransientError(rawError) ? timeoutMessage("GLM-4.6V-FlashX") : rawError);
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
    throw new Error(isTransientError(rawError) ? timeoutMessage("Gemini 3 Flash Preview") : rawError);
  }

  return extractGeminiReply(payload) || "当前没有拿到有效回复。";
}

async function callXiaomi(env, model, messages) {
  if (!env.XIAOMI_API_KEY) {
    throw new Error("服务端未配置 XIAOMI_API_KEY");
  }

  const url = env.XIAOMI_API_URL || DEFAULT_XIAOMI_URL;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": env.XIAOMI_API_KEY,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        top_p: 0.7,
        messages,
      }),
    });
  } catch {
    throw new Error(timeoutMessage("MiMo-V2-Omni"));
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const rawError = payload?.error?.message || payload?.message || `MiMo 调用失败：${response.status}`;
    throw new Error(isTransientError(rawError) ? timeoutMessage("MiMo-V2-Omni") : rawError);
  }

  return extractGlmReply(payload) || "当前没有拿到有效回复。";
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
      : runtime.provider === "xiaomi"
        ? await callXiaomi(env, runtime.model, [...systemContexts, ...conversation])
        : await callGlm(env, runtime.model, [...systemContexts, ...conversation]);

    return Response.json({ reply });
  } catch (error) {
    return Response.json({ error: error?.message || "服务端处理失败" }, { status: 500 });
  }
}