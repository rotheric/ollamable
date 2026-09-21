/**
 * Unit tests for AC-ERR-4 / architecture.md Order-Sensitive Composition
 * Flow 3: saveConversations' QuotaExceededError retry policy.
 *
 * `saveConversations` (src/lib/chat.ts) has exactly one localStorage
 * write for the entire `conversations` array (a single STORAGE_KEY). A
 * "quota failure on one conversation" therefore manifests as the single
 * write failing because of the array's total size; the retry strips
 * contentTokens from every step of every conversation and re-attempts
 * the same single write, so all conversations persist together or none
 * do — there is no per-conversation partial-write path to lose.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createConversation, loadConversations, saveConversations, STORAGE_KEY } from "@/src/lib/chat";
import type { Conversation, ConversationStep } from "@/src/types/chat";

function stepWithTokens(
  kind: ConversationStep["kind"],
  content: string,
  contentTokens: string[]
): ConversationStep {
  return {
    id: `${kind}-${content}`,
    kind,
    title: kind,
    content,
    createdAt: new Date().toISOString(),
    expanded: true,
    contentTokens,
  };
}

function makeConversationWithTokens(id: string): Conversation {
  const base = createConversation("qwen3:latest");
  return {
    ...base,
    id,
    steps: [
      stepWithTokens("system", "Be concise.", []),
      stepWithTokens("user", "Hi", ["Hi"]),
      stepWithTokens("reasoning", "Thinking...", ["Thinking", "..."]),
      stepWithTokens("assistant", "Hello there!", ["Hello", " there", "!"]),
    ],
  };
}

/**
 * Replaces window.localStorage.setItem with one that throws a
 * QuotaExceededError whenever `shouldThrow(value)` is true, and otherwise
 * delegates to the ORIGINAL setItem captured before the spy was installed
 * (not via the prototype chain — tests/setup/vitest.setup.ts installs a
 * plain closure-backed object, not a class instance, so there is no
 * prototype method to fall back to).
 */
function mockQuotaOnCondition(shouldThrow: (value: string) => boolean) {
  const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
  return vi.spyOn(window.localStorage, "setItem").mockImplementation((key, value) => {
    if (shouldThrow(value)) {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    }
    originalSetItem(key, value);
  });
}

describe("saveConversations quota-failure retry (AC-ERR-4)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("retries once with contentTokens stripped from every step of every conversation, and does not throw when the retry succeeds", () => {
    const conversations = [makeConversationWithTokens("conv-1"), makeConversationWithTokens("conv-2")];
    const setItemSpy = mockQuotaOnCondition((value) => value.includes("contentTokens"));

    expect(() => saveConversations(conversations)).not.toThrow();
    expect(setItemSpy).toHaveBeenCalledTimes(2);

    const [, firstPayload] = setItemSpy.mock.calls[0]!;
    const [, secondPayload] = setItemSpy.mock.calls[1]!;
    expect(firstPayload).toContain("contentTokens");
    expect(secondPayload).not.toContain("contentTokens");
  });

  it("recognizes the legacy Firefox DOMException name NS_ERROR_DOM_QUOTA_REACHED and runs the strip-and-retry path", () => {
    const conversations = [makeConversationWithTokens("conv-1")];
    const setItemSpy = vi.spyOn(window.localStorage, "setItem").mockImplementation((_key, value) => {
      if (value.includes("contentTokens")) {
        throw new DOMException("quota exceeded", "NS_ERROR_DOM_QUOTA_REACHED");
      }
    });

    expect(() => saveConversations(conversations)).not.toThrow();
    expect(setItemSpy).toHaveBeenCalledTimes(2);

    const [, firstPayload] = setItemSpy.mock.calls[0]!;
    const [, secondPayload] = setItemSpy.mock.calls[1]!;
    expect(firstPayload).toContain("contentTokens");
    expect(secondPayload).not.toContain("contentTokens");
  });

  it("recognizes a legacy DOMException with code 22 whose name is unrecognized, and runs the strip-and-retry path", () => {
    // DOMException.code is read-only and, per the legacy error-name table,
    // is normally *derived* from `name` (e.g. "QUOTA_EXCEEDED_ERR" -> 22).
    // jsdom's DOMException does not implement that legacy name->code
    // mapping (verified: constructing with name "QUOTA_EXCEEDED_ERR" under
    // this project's jsdom test environment yields code 0, not 22), so a
    // legacy-name construction can't be used here to reach the `code === 22`
    // branch. Instead this uses a minimal DOMException subclass that
    // overrides the `code` getter directly — it still satisfies
    // `instanceof DOMException` (isQuotaExceeded's guard) while carrying an
    // unrecognized `name`, isolating the `error.code === 22` branch from the
    // `error.name === ...` branches.
    class LegacyCodeOnlyQuotaException extends DOMException {
      constructor(message: string) {
        super(message, "SomeUnrecognizedLegacyName");
      }
      override get code() {
        return 22;
      }
    }

    const conversations = [makeConversationWithTokens("conv-1")];
    const setItemSpy = vi.spyOn(window.localStorage, "setItem").mockImplementation((_key, value) => {
      if (value.includes("contentTokens")) {
        throw new LegacyCodeOnlyQuotaException("quota exceeded");
      }
    });

    expect(() => saveConversations(conversations)).not.toThrow();
    expect(setItemSpy).toHaveBeenCalledTimes(2);

    const [, firstPayload] = setItemSpy.mock.calls[0]!;
    const [, secondPayload] = setItemSpy.mock.calls[1]!;
    expect(firstPayload).toContain("contentTokens");
    expect(secondPayload).not.toContain("contentTokens");
  });

  it("a quota failure on the full payload does not prevent any conversation from persisting: all round-trip after the stripped retry", () => {
    const conversations = [makeConversationWithTokens("conv-1"), makeConversationWithTokens("conv-2")];
    mockQuotaOnCondition((value) => value.includes("contentTokens"));

    saveConversations(conversations);

    // Read back via the raw key (bypassing loadConversations' tool-merging)
    // to assert the retry's stripped payload actually persisted both
    // conversations, not just one.
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as Conversation[];
    expect(persisted.map((c) => c.id).sort()).toEqual(["conv-1", "conv-2"]);
  });

  it("reload after a quota-triggered retry yields conversations whose steps carry no contentTokens field (boundary source resolves to unavailable), rather than dropped conversations", () => {
    const conversations = [makeConversationWithTokens("conv-1"), makeConversationWithTokens("conv-2")];
    const setItemSpy = mockQuotaOnCondition((value) => value.includes("contentTokens"));

    saveConversations(conversations);

    // JSON.stringify already omits undefined-valued keys, so a
    // hasOwnProperty check against the reloaded (JSON.parse'd) object
    // cannot distinguish "key removed" from "key set to undefined" — the
    // pre-serialization retry payload is the only place that distinction
    // is observable, along with the payload actually shrinking.
    const [, firstPayload] = setItemSpy.mock.calls[0]!;
    const [, secondPayload] = setItemSpy.mock.calls[1]!;
    expect(secondPayload).not.toContain("contentTokens");
    expect(secondPayload.length).toBeLessThan(firstPayload.length);

    const reloaded = loadConversations([]);
    expect(reloaded).toHaveLength(2);
    for (const conversation of reloaded) {
      expect(conversation.steps.length).toBeGreaterThan(0);
      for (const step of conversation.steps) {
        expect(step.contentTokens).toBeUndefined();
      }
    }
  });

  it("retries at most once: if the stripped retry also throws QuotaExceededError, the error does NOT propagate to the caller (AC-ERR-4)", () => {
    const setItemSpy = mockQuotaOnCondition(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => saveConversations([makeConversationWithTokens("conv-1")])).not.toThrow();
    expect(setItemSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("propagates non-quota errors immediately without retrying", () => {
    const setItemSpy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => saveConversations([makeConversationWithTokens("conv-1")])).toThrow("disk full");
    expect(setItemSpy).toHaveBeenCalledTimes(1);
  });

  it("propagates a non-quota error raised on the retry attempt itself", () => {
    let callCount = 0;
    const setItemSpy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      throw new Error("disk full on retry");
    });

    expect(() => saveConversations([makeConversationWithTokens("conv-1")])).toThrow("disk full on retry");
    expect(setItemSpy).toHaveBeenCalledTimes(2);
  });

  it("does not modify caller's conversation objects while stripping contentTokens for the retry", () => {
    const conversations = [makeConversationWithTokens("conv-1")];
    const originalTokens = conversations[0]!.steps.map((s) => s.contentTokens);
    mockQuotaOnCondition((value) => value.includes("contentTokens"));

    saveConversations(conversations);

    expect(conversations[0]!.steps.map((s) => s.contentTokens)).toEqual(originalTokens);
  });
});
