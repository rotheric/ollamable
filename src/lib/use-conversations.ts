"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Conversation, OllamaModel, ToolDefinition } from "@/src/types/chat";
import {
  createConversation,
  ensureConversationTools,
  fallbackModels,
  loadConversationOrder,
  loadConversations,
  loadSelectedConversationId,
  saveConversationOrder,
  saveConversations,
  saveSelectedConversationId,
} from "@/src/lib/chat";

/** Sidebar order: the saved order first, with conversations it does not know yet on top. */
export function orderVisibleConversations(
  conversations: Conversation[],
  conversationOrder: string[] | null
): Conversation[] {
  // A conversation appears in the sidebar once it has a user message, or a compaction summary (a fork).
  const filtered = conversations.filter((c) => c.steps.some((s) => s.kind === "user" || s.kind === "compaction"));
  if (!conversationOrder) return filtered;
  const byId = new Map(filtered.map((c) => [c.id, c]));
  const ordered: Conversation[] = [];
  for (const id of conversationOrder) {
    const c = byId.get(id);
    if (c) {
      ordered.push(c);
      byId.delete(id);
    }
  }
  // Append any conversations not in the saved order (new ones) at the top
  for (const c of filtered) {
    if (byId.has(c.id)) ordered.unshift(c);
  }
  return ordered;
}

/**
 * Owns the conversation list, its sidebar order and the selection, and keeps
 * all three persisted in browser storage.
 */
export function useConversations(tools: ToolDefinition[]) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationOrder, setConversationOrder] = useState<string[] | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string>("");

  useEffect(() => {
    const initialConversations = loadConversations([]);
    const selectedId = loadSelectedConversationId() ?? initialConversations[0]?.id ?? "";

    setConversations(initialConversations);
    setConversationOrder(loadConversationOrder());
    setSelectedConversationId(selectedId);
  }, []);

  // Re-sync existing conversations when the tool list changes
  useEffect(() => {
    if (tools.length === 0) return;
    setConversations((current) =>
      current.map((conv) => ensureConversationTools(conv, tools))
    );
  }, [tools]);

  useEffect(() => {
    if (conversations.length === 0) {
      return;
    }

    saveConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    if (selectedConversationId) {
      saveSelectedConversationId(selectedConversationId);
    }
  }, [selectedConversationId]);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId]
  );

  useEffect(() => {
    if (!selectedConversation && conversations.length > 0) {
      setSelectedConversationId(conversations[0].id);
    }
  }, [conversations, selectedConversation]);

  const updateConversation = useCallback(
    (id: string, updater: (conversation: Conversation) => Conversation) => {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === id ? updater(conversation) : conversation
        )
      );
    },
    []
  );

  const addConversation = useCallback(
    (model: OllamaModel | undefined) => {
      const conversation = createConversation(model?.name ?? fallbackModels[0].name, tools, model?.provider);
      setConversations((current) => [conversation, ...current]);
      setSelectedConversationId(conversation.id);
    },
    [tools]
  );

  /** Adds a conversation forked from another and selects it. */
  const addForkedConversation = useCallback((fork: Conversation) => {
    setConversations((current) => [fork, ...current]);
    setSelectedConversationId(fork.id);
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setConversations((current) => {
      const remaining = current.filter((conversation) => conversation.id !== id);

      setSelectedConversationId((currentSelectedId) => {
        if (currentSelectedId !== id) {
          return currentSelectedId;
        }

        return remaining[0]?.id ?? "";
      });

      return remaining;
    });

    setConversationOrder((current) => {
      if (!current) return current;
      const updated = current.filter((cid) => cid !== id);
      saveConversationOrder(updated);
      return updated;
    });
  }, []);

  const reorderConversations = useCallback((order: string[]) => {
    setConversationOrder(order);
    saveConversationOrder(order);
  }, []);

  return {
    conversations,
    setConversations,
    conversationOrder,
    setConversationOrder,
    selectedConversationId,
    setSelectedConversationId,
    selectedConversation,
    updateConversation,
    addConversation,
    addForkedConversation,
    deleteConversation,
    reorderConversations,
  };
}
