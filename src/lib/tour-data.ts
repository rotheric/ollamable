import { tourConversationSignature } from "@/src/lib/tour-session";
import type { Step } from "react-joyride";
import type { Conversation, ToolDefinition } from "@/src/types/chat";
import { createId, createStep } from "@/src/lib/chat";

export const TOUR_COMPLETED_KEY = "ollamable.tourCompleted";
export const TOUR_STEP_KEY = "ollamable.tourStep";

export const tourSteps: Step[] = [
  // App Bar
  {
    target: '[data-tour="tools-overview"]',
    title: "Active Tools",
    content:
      "This card lists the tools enabled for this conversation. Expand it to inspect their descriptions; click a tool to open its settings on the right.",
    placement: "bottom",
  },

  // System Prompt
  {
    target: '[data-tour="system-prompt"]',
    title: "System Prompt",
    content:
      "This is the system-level instruction sent before any user message. It shapes the model's behavior for the entire conversation. Try changing it and resending to see how responses differ.",
    placement: "bottom",
  },

  // Step Cards — Conversation 1
  {
    target: '[data-tour="step-user"]',
    title: "User Message",
    content:
      "Your messages appear as blue cards. Click the expand/collapse toggle to save space, or click the edit icon to modify and resend a message from any point in the conversation.",
    placement: "left",
  },
  {
    target: '[data-tour="step-assistant"]',
    title: "Assistant Response",
    content:
      "The model's replies appear as green cards. The footer shows token counts (input/output) and the stop reason. Click the regenerate icon to get a different response.",
    placement: "left",
  },
  {
    target: '[data-tour="step-reasoning"]',
    title: "Reasoning / Thinking",
    content:
      'When a model supports chain-of-thought, its internal reasoning appears as amber cards. This is the "thinking" the model does before producing a visible answer — normally hidden in other chat UIs.',
    placement: "left",
  },

  // Tool Use — switch to Conversation 2
  {
    target: '[data-tour="step-tool-result"]',
    title: "Tool Result",
    content:
      "When the model uses a tool, it emits a tool_call with the function name and arguments. After the backend executes the call, the result appears here as a tool_result step. The model reads this and incorporates it into its next reply.",
    placement: "left",
  },
  {
    target: '[data-tour="step-meta"]',
    title: "Meta Events",
    content:
      "Meta events (cyan cards) show server-side activity driven by the harness (agent) layer — the backend code that orchestrates the LLM. This includes MCP server connections, search dispatches, and timing data, giving you full visibility into what happens behind the scenes.",
    placement: "left",
  },

  // Right Sidebar — Settings
  {
    target: '[data-tour="models-section"]',
    title: "Models",
    content:
      'Browse and select from all available models. Models are grouped by provider (Ollama, MiniMax, etc.). Use the search box to filter, or toggle "show reasoning only" to find models with chain-of-thought support.',
    placement: "left",
  },
  {
    target: '[data-tour="temperature-section"]',
    title: "Temperature",
    content:
      "Temperature controls randomness. Low values (0.0 - 0.3) produce focused, deterministic answers. High values (1.2+) produce creative, varied responses. Click a chip to set the temperature for this conversation.",
    placement: "left",
  },
  {
    target: '[data-tour="max-tokens-section"]',
    title: "Max Output Tokens",
    content:
      "Limit how many tokens the model can produce in a single response. Useful for keeping answers concise or for testing how models handle truncation.",
    placement: "left",
  },
  {
    target: '[data-tour="tools-section"]',
    title: "Tools",
    content:
      "Tools extend what the model can do. Each tool has a name, description, and a JSON schema defining its input parameters. Enable or disable tools per conversation using the checkboxes.",
    placement: "left",
  },
];

export function createTourConversations(
  model: string,
  tools: ToolDefinition[]
): Conversation[] {
  const now = new Date().toISOString();

  const systemPrompt =
    "You are a research assistant with access to web search. Always cite your sources.";
  const systemStep = createStep("system", "System Prompt", systemPrompt);
  const userStep = createStep(
    "user",
    "User",
    "What was the most recent SpaceX launch?"
  );

  const meta1 = createStep(
    "meta",
    "Web Search",
    "Searching: latest SpaceX launch 2026"
  );
  meta1.metaEvent = {
    kind: "search_start",
    title: "Web Search",
    detail: "Searching: latest SpaceX launch 2026",
  };

  const toolCall = createStep(
    "tool_call",
    "web_search",
    JSON.stringify(
      { query: "latest SpaceX launch 2026", count: 3 },
      null,
      2
    ),
    { name: "web_search", arguments: { query: "latest SpaceX launch 2026", count: 3 } }
  );

  const meta2 = createStep(
    "meta",
    "Search Complete",
    "3 results returned"
  );
  meta2.metaEvent = {
    kind: "search_result",
    title: "Search Complete",
    detail: "3 results returned",
    durationMs: 420,
  };

  const searchResults = [
    {
      title: "SpaceX Launches Starship Flight 8 Successfully",
      url: "https://www.spacex.com/launches/starship-flight-8",
      snippet:
        "SpaceX completed its eighth integrated Starship test flight on March 15, 2026, achieving successful booster catch and orbital insertion.",
    },
    {
      title: "Starship Flight 8: Full Mission Overview - SpaceNews",
      url: "https://spacenews.com/starship-flight-8-overview",
      snippet:
        "The Starship upper stage reached orbit and deployed a batch of test satellites before a controlled deorbit over the Pacific Ocean.",
    },
    {
      title: "SpaceX Starship Flight 8 Launch Updates - NASA Spaceflight",
      url: "https://www.nasaspaceflight.com/2026/03/starship-flight-8",
      snippet:
        "Flight 8 launched from Starbase, Boca Chica, Texas at 8:45 AM CT. The Super Heavy booster was caught by the launch tower arms approximately 7 minutes after liftoff.",
    },
  ];

  const toolResult = createStep(
    "tool_result",
    "web_search",
    JSON.stringify(searchResults, null, 2),
    undefined,
    { name: "web_search" }
  );

  const reasoning = createStep(
    "reasoning",
    "Reasoning",
    "The search results all point to Starship Flight 8 on March 15, 2026, as the most recent SpaceX launch. I have three consistent sources. I'll synthesize the key details — date, mission name, launch site, and outcome — and cite each source."
  );

  const assistant = createStep(
    "assistant",
    "Assistant",
    `The most recent SpaceX launch was **Starship Flight 8**, which took place on **March 15, 2026** from Starbase in Boca Chica, Texas.

The mission achieved several milestones: the Super Heavy booster was successfully caught by the launch tower arms approximately 7 minutes after liftoff, and the Starship upper stage reached orbit, deployed a batch of test satellites, and performed a controlled deorbit over the Pacific Ocean.

**Sources:**
1. [SpaceX Official](https://www.spacex.com/launches/starship-flight-8)
2. [SpaceNews](https://spacenews.com/starship-flight-8-overview)
3. [NASA Spaceflight](https://www.nasaspaceflight.com/2026/03/starship-flight-8)`
  );
  assistant.usage = {
    inputTokens: 312,
    outputTokens: 156,
    stopReason: "stop",
  };

  const webSearchTool = tools.find((t) => t.name === "web_search");
  const activeToolIds = webSearchTool ? [webSearchTool.id] : [];

  const conversation: Conversation = {
    id: createId(),
    title: "Search for the latest SpaceX launch",
    titleEdited: false,
    model,
    temperature: 0.3,
    maxOutputTokens: 1000,
    systemPrompt,
    createdAt: now,
    updatedAt: now,
    availableTools: tools,
    activeToolIds,
    steps: [
      systemStep,
      userStep,
      meta1,
      toolCall,
      meta2,
      toolResult,
      reasoning,
      assistant,
    ],
    _tourExample: true,
  };

  conversation._tourSeed = tourConversationSignature(conversation);
  return [conversation];
}
