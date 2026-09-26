import type { Conversation } from "@/src/types/chat";

/** Exclude presentation toggles, timestamps and automatically discovered tools. */
export function tourConversationSignature(conversation: Conversation): string {
  return JSON.stringify({
    title: conversation.title, note: conversation.note ?? "", systemPrompt: conversation.systemPrompt,
    model: conversation.model, temperature: conversation.temperature, maxOutputTokens: conversation.maxOutputTokens,
    reasoningEffort: conversation.reasoningEffort,
    steps: conversation.steps.map(({ kind, content, toolCall, toolCalls, toolResult }) => ({ kind, content, toolCall, toolCalls, toolResult })),
  });
}

export function finishTourConversations(current: Conversation[], legacySeed: (conversation: Conversation) => Conversation): Conversation[] {
  return current.flatMap((conversation) => {
    if (!conversation._tourExample) return [conversation];
    const baseline = conversation._tourSeed ?? tourConversationSignature(legacySeed(conversation));
    if (tourConversationSignature(conversation) === baseline) return [];
    const { _tourExample, _tourSeed, ...preserved } = conversation;
    return [preserved];
  });
}
