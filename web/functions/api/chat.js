const DEFAULT_MODEL = "glm-4.6v-flashx";
const DEFAULT_GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_DOC_KEY = "GLM.md";

function buildSystemPrompt(activeTab) {
  const tabHint = activeTab ? `当前用户正在查看的页面是：${activeTab}。` : "";
  return [
    "你是 IFRS17 财务影响测试平台的内置问答助手。",
    tabHint,
    "请严格依据系统提供的知识文档和追溯上下文回答，不要编造当前系统中不存在的规则。",
    "回答默认使用中文，尽量简短直接。",
    "如果用户问业务实质，优先解释业务含义和影响。",
    "如果用户问原因或数字来源，优先回答具体数据、来源报表/节点和关键计算过程。",
    "如果用户问公式，优先给公式和最必要的变量解释。",
    "除非用户明确要求，不要同时展开业务、公式、示例、长篇背景。",
    "如果当前文档或系统未定义，就明确说当前未定义。"
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

function extractReply(payload) {
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

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json();
    const activeTab = body?.activeTab || "";
    const traceContext = typeof body?.traceContext === "string" ? body.traceContext.trim() : "";
    const messages = normalizeMessages(body?.messages);

    if (!messages.length) {
      return Response.json({ error: "消息为空" }, { status: 400 });
    }

    if (!env.GLM_API_KEY) {
      return Response.json({ error: "服务端未配置 GLM_API_KEY" }, { status: 500 });
    }

    const knowledge = await loadKnowledge(env);
    const chatMessages = [
      { role: "system", content: buildSystemPrompt(activeTab) },
      {
        role: "system",
        content: `以下是系统当前版本的 IFRS17 引擎知识文档，请严格以此为准回答问题：\n\n${knowledge}`,
      },
    ];

    if (traceContext) {
      chatMessages.push({
        role: "system",
        content: `以下是系统基于当前活动情景生成的数字追溯上下文，请优先依据它回答具体数字来源问题：\n\n${traceContext}`,
      });
    }

    chatMessages.push(...messages.slice(-12));

    let response;
    try {
      response = await fetch(env.GLM_API_URL || DEFAULT_GLM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.GLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: env.GLM_MODEL || DEFAULT_MODEL,
          temperature: 0.2,
          top_p: 0.7,
          messages: chatMessages,
        }),
      });
    } catch (fetchError) {
      return Response.json({ error: "试验版本使用GLM-4.6V-FlashX，大模型偶尔返回超时，请再试一次。" }, { status: 502 });
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const rawError = payload?.error?.message || payload?.message || `GLM 调用失败（${response.status}）`;
      const errorMessage = /timeout|timed out|deadline|network|fetch/i.test(String(rawError))
        ? "试验版本使用GLM-4.6V-FlashX，大模型偶尔返回超时，请再试一次。"
        : rawError;
      return Response.json({ error: errorMessage }, { status: response.status });
    }

    const reply = extractReply(payload);
    return Response.json({ reply: reply || "当前没有拿到有效回复。" });
  } catch (error) {
    return Response.json({ error: error?.message || "服务端处理失败" }, { status: 500 });
  }
}


