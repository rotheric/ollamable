import { withNetworkDeadline, TOOL_REQUEST_TIMEOUT_MS } from "../network-deadline.js";
import { randomUUID } from "node:crypto";
import type { ToolExecutor } from "../tool-executor.js";
import type { MetaEvent, ToolDefinition } from "../types.js";

export class WebSearchExecutor implements ToolExecutor {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.BRAVE_API_KEY ?? "";
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        id: "web-search",
        name: "web_search",
        description:
          "Searches the web using Brave Search and returns relevant results with titles, URLs, and snippets.",
        inputSchema: JSON.stringify({
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" },
            count: {
              type: "number",
              description: "Number of results to return (default 5, max 20)",
            },
          },
          required: ["query"],
        }),
      },
    ];
  }

  canHandle(name: string): boolean {
    return name === "web_search";
  }

  async execute(
    _name: string,
    args: Record<string, unknown>,
    emit: (event: MetaEvent) => void,
    signal?: AbortSignal
  ): Promise<string> {
    signal?.throwIfAborted();
    const query = String(args.query ?? "");
    const count = Math.min(Number(args.count) || 5, 20);
    const startTime = Date.now();

    emit({
      id: randomUUID(),
      kind: "search_start",
      title: "Web Search",
      detail: "",
      data: { query },
      timestamp: new Date().toISOString(),
    });

    if (!this.isConfigured()) {
      const message = "BRAVE_API_KEY is not set. Configure it in the server environment to enable web search.";
      emit({
        id: randomUUID(),
        kind: "search_result",
        title: "Search Not Configured",
        detail: message,
        data: { error: message, query },
        timestamp: new Date().toISOString(),
        durationMs: 0,
      });
      return JSON.stringify({ query, error: message });
    }

    try {
      const params = new URLSearchParams({ q: query, count: String(count) });
      const data = await withNetworkDeadline(async (requestSignal) => {
        const response = await fetch(
          `https://api.search.brave.com/res/v1/web/search?${params}`,
          {
            signal: requestSignal,
            headers: {
              Accept: "application/json",
              "Accept-Encoding": "gzip",
              "X-Subscription-Token": this.apiKey,
            },
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Brave Search API error ${response.status}: ${errorText}`
          );
        }

        return (await response.json()) as BraveSearchResponse;
      }, signal, TOOL_REQUEST_TIMEOUT_MS);
      const results: SearchResult[] = (data.web?.results ?? [])
        .slice(0, count)
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description ?? "",
        }));

      const durationMs = Date.now() - startTime;

      emit({
        id: randomUUID(),
        kind: "search_result",
        title: "Search Results",
        detail: `${results.length} result(s) in ${durationMs}ms`,
        data: { results, query, durationMs },
        timestamp: new Date().toISOString(),
        durationMs,
      });

      if (results.length === 0) {
        return JSON.stringify({
          query,
          results: [],
          summary: "No results found.",
        });
      }

      return JSON.stringify({ query, results });
    } catch (error) {
      signal?.throwIfAborted();
      const durationMs = Date.now() - startTime;
      const message =
        error instanceof Error ? error.message : "Unknown search error";

      emit({
        id: randomUUID(),
        kind: "search_result",
        title: "Search Failed",
        detail: message,
        data: { error: message, query },
        timestamp: new Date().toISOString(),
        durationMs,
      });

      return JSON.stringify({ query, error: message });
    }
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title: string;
      url: string;
      description?: string;
    }>;
  };
}
