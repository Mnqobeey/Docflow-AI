const DEFAULT_MODEL = "deepseek/deepseek-chat-v3.1";
const DEFAULT_TIMEOUT_MS = 18000;

function safeDevLog(message, err) {
  if (process.env.NODE_ENV === "production") return;
  const detail = err?.message || err;
  console.warn(`[ai-provider] ${message}${detail ? `: ${detail}` : ""}`);
}

function timeoutMs() {
  const value = Number(process.env.AI_PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function safePreview(value) {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value || "").slice(0, 500);
  }
}

function contentPartText(part) {
  if (!part) return "";
  if (typeof part === "string") return part;
  if (Array.isArray(part)) return part.map(contentPartText).filter(Boolean).join("\n");
  if (typeof part !== "object") return "";

  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (Array.isArray(part.content)) return part.content.map(contentPartText).filter(Boolean).join("\n");
  return "";
}

function readBalancedJsonObject(text, start) {
  const expectedClosers = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") expectedClosers.push("}");
    else if (ch === "[") expectedClosers.push("]");
    else if (ch === "}" || ch === "]") {
      if (expectedClosers[expectedClosers.length - 1] !== ch) return "";
      expectedClosers.pop();
      if (!expectedClosers.length) return text.slice(start, i + 1);
    }
  }

  return "";
}

function firstJsonObjectFromText(text = "") {
  const raw = String(text || "");
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== "{") continue;
    const block = readBalancedJsonObject(raw, i);
    if (!block) continue;
    try {
      const parsed = JSON.parse(block);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return block;
    } catch {
      // Keep scanning; reasoning text can contain brace-like prose.
    }
  }
  return "";
}

function openRouterText(data) {
  const choices = data?.choices || [];
  const content = choices
    .map((choice) => contentPartText(choice?.message?.content) || contentPartText(choice?.delta?.content) || choice?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
  if (content) return { text: content, reasoningOnly: false };

  const reasoning = choices
    .map((choice) => contentPartText(choice?.message?.reasoning) || contentPartText(choice?.message?.reasoning_content))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!reasoning) return { text: "", reasoningOnly: false };

  const json = firstJsonObjectFromText(reasoning);
  return { text: json, reasoningOnly: true };
}

async function callOpenRouter({ messages, temperature = 0, maxTokens = 900 }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");

  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:5173",
      "X-Title": "DocFlow AI",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const metadata = data?.error?.metadata || data?.metadata || null;
    const metadataPreview = metadata ? ` metadata=${safePreview(metadata)}` : "";
    const detail = `${data?.error?.message || data?.message || `OpenRouter HTTP ${res.status}`}${metadataPreview}`;
    throw new Error(detail);
  }

  const { text, reasoningOnly } = openRouterText(data);
  if (reasoningOnly && !text) {
    safeDevLog("OpenRouter model returned reasoning-only output; choose a content-returning model.");
    throw new Error("OpenRouter model returned reasoning-only output; choose a content-returning model.");
  }
  if (reasoningOnly && text) {
    safeDevLog("OpenRouter model returned reasoning-only output with an embedded JSON object; using that JSON object.");
  }
  if (!text) {
    safeDevLog(`OpenRouter returned no text; response preview ${safePreview(data)}`);
    throw new Error("OpenRouter returned no text");
  }
  return text;
}

async function requestOpenRouterJson({ system, user, temperature = 0, maxTokens = 900 }) {
  const text = await callOpenRouter({
    temperature,
    maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return text;
}

module.exports = {
  callOpenRouter,
  requestOpenRouterJson,
  safeDevLog,
};
