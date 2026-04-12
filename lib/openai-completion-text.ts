/**
 * Parse assistant-visible text from OpenAI-style `POST /v1/chat/completions` JSON.
 * Used by SGLang (Qwen reasoning parsers, multipart content) and the chat UI.
 */

/** Normalize OpenAI-style `message.content` (string, or array of text/ref parts). */
export function normalizeChatContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return null;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (typeof part === "object" && part !== null) {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") parts.push(p.text);
        else if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
      }
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  if (typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.type === "text" && typeof o.text === "string") return o.text;
  }
  return null;
}

/**
 * Extract assistant-visible text from `POST /v1/chat/completions` JSON.
 * Qwen / SGLang may use string or array `content`, or `reasoning_content` when present.
 */
export function assistantFromCompletionBody(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const c = first as Record<string, unknown>;

  if (typeof c.text === "string") return c.text;

  const msg = c.message;
  if (typeof msg === "object" && msg !== null) {
    const m = msg as Record<string, unknown>;
    const fromContent = normalizeChatContent(m.content);
    // Treat empty string like missing: Qwen3 / SGLang often put the reply in
    // `reasoning_content` and leave `content` as "".
    if (fromContent !== null && fromContent.trim().length > 0) {
      return fromContent;
    }
    if (typeof m.reasoning_content === "string" && m.reasoning_content.trim().length > 0) {
      return m.reasoning_content;
    }
    if (typeof m.reasoning === "string" && m.reasoning.trim().length > 0) return m.reasoning;
  }
  return null;
}
