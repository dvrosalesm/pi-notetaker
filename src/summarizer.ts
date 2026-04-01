/**
 * Meeting summarizer - uses the pi agent's active LLM to generate
 * structured meeting summaries from transcripts.
 */

import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const SUMMARY_SYSTEM_PROMPT = `You are a meeting notes assistant. Given a raw transcript of a meeting, produce a clean, structured summary.

Output format (markdown):

# Meeting Summary

## Key Points
- Bullet points of the most important topics discussed

## Decisions Made
- Any decisions or agreements reached

## Action Items
- [ ] Task — Owner (if mentioned)

## Notes
Any additional context, open questions, or follow-ups worth capturing.

Guidelines:
- Be concise but don't omit important details
- Use speaker names if identifiable from the transcript
- If the transcript is unclear, note that rather than guessing
- Group related discussion points together
- Keep action items specific and actionable`;

export async function summarize(
  transcript: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ summary: string } | { error: string }> {
  if (!ctx.model) {
    return { error: "No model selected in pi. Select a model with /model first." };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) {
    return { error: auth.error };
  }
  if (!auth.apiKey) {
    return { error: `No API key configured for ${ctx.model.provider}` };
  }

  const userMessage: UserMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `Here is the meeting transcript to summarize:\n\n<transcript>\n${transcript}\n</transcript>`,
      },
    ],
    timestamp: Date.now(),
  };

  try {
    const response = await complete(
      ctx.model,
      { systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers, signal },
    );

    if (response.stopReason === "aborted") {
      return { error: "Summarization was cancelled" };
    }

    const summary = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    if (!summary.trim()) {
      return { error: "LLM returned an empty summary" };
    }

    return { summary };
  } catch (err: any) {
    return { error: `Summarization failed: ${err.message}` };
  }
}
