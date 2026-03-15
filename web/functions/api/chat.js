const DEFAULT_MODEL = "glm-4.6v-flashx";
const DEFAULT_GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_DOC_KEY = "ifrs17-engine-knowledge-base.md";

function buildSystemPrompt(activeTab) {
  const tabHint = activeTab ? `当前用户正在查看的页面是：${activeTab}。` : "";
  return [
    "你是 IFRS17 财务影响测试平台的内置问答助手。",
    tabHint,
    "请优先依据系统提供的引擎知识文档回答问题，不要编造当前系统中不存在的规则。",
    "如果问题超出当前文档或系统实现范围，要明确说明当前文档/系统未定义。",
    "回答尽量使用中文，并保持结构清晰、可复核。",
    "如果用户问某个指标如何计算，优先按 来源 -> 公式 -> 文字解释 -> 示例 的顺序回答。",
    "如果用户问报表项目，优先说明它来自哪个 Node 或哪个后处理层。",
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
    const includeKnowledge = Boolean(body?.includeKnowledge);
    const activeTab = body?.activeTab || "";
    const messages = normalizeMessages(body?.messages);

    if (!messages.length) {
      return Response.json({ error: "消息为空" }, { status: 400 });
    }

    if (!env.GLM_API_KEY) {
      return Response.json({ error: "服务端未配置 GLM_API_KEY" }, { status: 500 });
    }

    const chatMessages = [
      { role: "system", content: buildSystemPrompt(activeTab) },
    ];

    if (includeKnowledge) {
      const knowledge = await loadKnowledge(env);
      chatMessages.push({
        role: "system",
        content: `以下是系统当前版本的 IFRS17 引擎知识文档，请严格以此为准回答问题：\n\n${knowledge}`,
      });
    }

    chatMessages.push(...messages.slice(-12));

    const response = await fetch(env.GLM_API_URL || DEFAULT_GLM_URL, {
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

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = payload?.error?.message || payload?.message || `GLM 调用失败（${response.status}）`;
      return Response.json({ error: errorMessage }, { status: response.status });
    }

    const reply = extractReply(payload);
    return Response.json({ reply: reply || "当前没有拿到有效回复。" });
  } catch (error) {
    return Response.json(
      { error: error?.message || "服务端处理失败" },
      { status: 500 }
    );
  }
}
