import { describe, expect, it } from "vitest";
import { assistantFromCompletionBody, normalizeChatContent } from "./openai-completion-text.js";

describe("normalizeChatContent", () => {
  it("returns plain strings", () => {
    expect(normalizeChatContent("hello")).toBe("hello");
  });

  it("joins array of text parts", () => {
    expect(
      normalizeChatContent([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  it("returns null for empty array", () => {
    expect(normalizeChatContent([])).toBeNull();
  });
});

describe("assistantFromCompletionBody", () => {
  it("reads choices[0].message.content string", () => {
    const body = {
      choices: [{ message: { role: "assistant", content: "Hi" } }],
    };
    expect(assistantFromCompletionBody(body)).toBe("Hi");
  });

  it("reads choices[0].text (completions-style)", () => {
    const body = { choices: [{ text: "Done" }] };
    expect(assistantFromCompletionBody(body)).toBe("Done");
  });

  it("uses reasoning_content when message.content is absent", () => {
    const body = {
      choices: [
        {
          message: {
            role: "assistant",
            reasoning_content: "think step",
          },
        },
      ],
    };
    expect(assistantFromCompletionBody(body)).toBe("think step");
  });

  it("uses reasoning_content when message.content is empty string (Qwen3 + SGLang)", () => {
    const body = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            reasoning_content: "Hello, world!",
          },
        },
      ],
    };
    expect(assistantFromCompletionBody(body)).toBe("Hello, world!");
  });

  it("uses multipart content arrays", () => {
    const body = {
      choices: [
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x" }, { type: "text", text: "y" }],
          },
        },
      ],
    };
    expect(assistantFromCompletionBody(body)).toBe("xy");
  });

  it("returns null for invalid shapes", () => {
    expect(assistantFromCompletionBody(null)).toBeNull();
    expect(assistantFromCompletionBody({})).toBeNull();
    expect(assistantFromCompletionBody({ choices: [] })).toBeNull();
  });
});
