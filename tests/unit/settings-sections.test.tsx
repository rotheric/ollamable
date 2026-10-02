import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OllamaModel, ToolDefinition } from "@/src/types/chat";
import { ModelsSection } from "@/src/components/settings/models-section";
import { ToolsSection, toolSubsectionKey } from "@/src/components/settings/tools-section";
import { modelSelectKey } from "@/src/lib/models";

function tool(id: string, name: string, inputSchema = "{}"): ToolDefinition {
  return { id, name, description: `${name} description`, inputSchema };
}

const curl = tool("curl", "curl", JSON.stringify({
  type: "object",
  properties: { url: { type: "string" }, method: { type: "string" }, headers: {} },
  required: ["url"],
}));
const webSearch = tool("web-search", "web_search");
const navigate = tool("mcp-playwright-browser_navigate", "browser_navigate");
const click = tool("mcp-playwright-browser_click", "browser_click");
const query = tool("mcp-db-query", "query");

function renderTools(overrides: Partial<Parameters<typeof ToolsSection>[0]> = {}) {
  const props = {
    open: true,
    onToggle: vi.fn(),
    availableTools: [curl, webSearch, navigate, click, query],
    activeToolIds: [] as string[],
    // Subsections open, as after the user expanded them.
    isSubsectionOpen: () => true,
    onToggleSubsection: vi.fn(),
    onToggleTool: vi.fn(),
    onDisableAllTools: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ToolsSection {...props} />) };
}

function listedToolIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-tool-id]")].map((el) => el.getAttribute("data-tool-id")!);
}

describe("toolSubsectionKey", () => {
  it("files MCP tools under their server and everything else under built-in", () => {
    expect(toolSubsectionKey("mcp-playwright-browser_navigate")).toBe("tools-mcp-playwright");
    expect(toolSubsectionKey("curl")).toBe("tools-builtin");
    expect(toolSubsectionKey("web-search")).toBe("tools-builtin");
  });
});

describe("ToolsSection", () => {
  it("lists built-in tools first, then one subsection per MCP server", () => {
    const { container } = renderTools();

    expect(listedToolIds(container)).toEqual([
      "curl", "web-search", "mcp-playwright-browser_navigate", "mcp-playwright-browser_click", "mcp-db-query",
    ]);
    expect(screen.getByText("built-in")).toBeInTheDocument();
    expect(screen.getByText("playwright")).toBeInTheDocument();
    expect(screen.getByText("db")).toBeInTheDocument();
  });

  it("toggling a tool reports its id", async () => {
    const { props } = renderTools();

    await userEvent.click(screen.getByRole("checkbox", { name: /browser_click/ }));

    expect(props.onToggleTool).toHaveBeenCalledExactlyOnceWith("mcp-playwright-browser_click");
  });

  it("checks exactly the conversation's active tools", () => {
    renderTools({ activeToolIds: ["curl", "mcp-db-query"] });

    expect(screen.getByRole("checkbox", { name: /^curl/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^query/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /web_search/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /browser_navigate/ })).not.toBeChecked();
  });

  it('"show active only" filters built-in and MCP tools as soon as it is switched on', async () => {
    const { container } = renderTools({ activeToolIds: ["curl", "mcp-playwright-browser_click"] });

    await userEvent.click(screen.getByText("show active only"));

    expect(listedToolIds(container)).toEqual(["curl", "mcp-playwright-browser_click"]);
    // A server with no matching tool disappears entirely.
    expect(screen.queryByText("db")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText("show active only"));
    expect(listedToolIds(container)).toHaveLength(5);
  });

  it("search matches tool names case-insensitively across built-in and MCP tools", async () => {
    const { container } = renderTools();

    await userEvent.type(screen.getByPlaceholderText("Search tools…"), "BROWSER");

    expect(listedToolIds(container)).toEqual(["mcp-playwright-browser_navigate", "mcp-playwright-browser_click"]);
  });

  it("an active filter force-expands collapsed subsections so matches are visible", async () => {
    renderTools({ isSubsectionOpen: () => false });
    // MUI's Collapse marks a closed panel with the hidden class and keeps its content mounted.
    const panelOf = (id: string) => document.querySelector(`[data-tool-id="${id}"]`)!.closest(".MuiCollapse-root")!;
    expect(panelOf("curl")).toHaveClass("MuiCollapse-hidden");

    await userEvent.type(screen.getByPlaceholderText("Search tools…"), "curl");

    expect(panelOf("curl")).not.toHaveClass("MuiCollapse-hidden");
  });

  it("toggling a subsection header reports that subsection's key", async () => {
    const { props } = renderTools();

    await userEvent.click(screen.getByText("playwright"));
    await userEvent.click(screen.getByText("built-in"));

    expect(vi.mocked(props.onToggleSubsection).mock.calls).toEqual([["tools-mcp-playwright"], ["tools-builtin"]]);
  });

  it('"disable all" is unavailable with no active tool and reports a click otherwise', async () => {
    const idle = renderTools();
    expect(screen.getByText("disable all").closest(".MuiChip-root")).toHaveClass("Mui-disabled");
    idle.unmount();

    const { props } = renderTools({ activeToolIds: ["curl"] });
    await userEvent.click(screen.getByText("disable all"));
    expect(props.onDisableAllTools).toHaveBeenCalledOnce();
  });

  it("marks the first listed tool as the tour target: a built-in one, else the first MCP tool", () => {
    const withBuiltin = renderTools();
    expect(withBuiltin.container.querySelectorAll('[data-tour="tool-card"]')).toHaveLength(1);
    expect(withBuiltin.container.querySelector('[data-tour="tool-card"]')).toHaveAttribute("data-tool-id", "curl");
    withBuiltin.unmount();

    const mcpOnly = renderTools({ availableTools: [navigate, click, query] });
    expect(mcpOnly.container.querySelectorAll('[data-tour="tool-card"]')).toHaveLength(1);
    expect(mcpOnly.container.querySelector('[data-tour="tool-card"]')).toHaveAttribute("data-tool-id", "mcp-playwright-browser_navigate");
  });

  it("renders a tool's parameters as a table with types and required flags", () => {
    renderTools({ availableTools: [curl] });
    const table = screen.getByRole("table");

    const rows = within(table).getAllByRole("row").slice(1).map((row) => {
      const [name, type] = within(row).getAllByRole("cell");
      return [name.textContent, type.textContent, within(row).getByRole("checkbox").hasAttribute("checked")];
    });
    expect(rows).toEqual([
      ["url", "string", true],
      ["method", "string", false],
      ["headers", "—", false],
    ]);
  });

  it("shows no parameter table for a tool without properties", () => {
    renderTools({ availableTools: [webSearch] });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the raw schema text when it is not JSON", () => {
    renderTools({ availableTools: [tool("odd", "odd", "query: string")] });
    expect(screen.getByText("query: string")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

const qwen: OllamaModel = { name: "qwen3:latest", provider: "ollama", providerName: "Ollama", capabilities: ["thinking"] };
const llama: OllamaModel = { name: "llama3.2:latest", provider: "ollama", providerName: "Ollama" };
const minimax: OllamaModel = { name: "MiniMax-M2", provider: "minimax", providerName: "MiniMax" };

function renderModels(overrides: Partial<Parameters<typeof ModelsSection>[0]> = {}) {
  const props = {
    open: true,
    onToggle: vi.fn(),
    models: [qwen, llama, minimax],
    selectedModelKey: modelSelectKey(qwen.provider, qwen.name),
    isSubsectionOpen: () => true,
    onToggleSubsection: vi.fn(),
    onSelectModel: vi.fn(),
    onOpenModelMeta: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ModelsSection {...props} />) };
}

describe("ModelsSection", () => {
  it("selecting a model reports the model itself, provider included", async () => {
    const { props } = renderModels();

    await userEvent.click(screen.getByText("MiniMax-M2"));

    expect(props.onSelectModel).toHaveBeenCalledExactlyOnceWith(minimax);
  });

  it("keeps a provider-less model's name intact even though it contains a colon", async () => {
    const fallback: OllamaModel = { name: "llama3.2:latest" };
    const { props } = renderModels({ models: [{ name: "qwen3:latest" }, fallback], selectedModelKey: "qwen3:latest" });

    await userEvent.click(screen.getByText("llama3.2:latest"));

    expect(props.onSelectModel).toHaveBeenCalledExactlyOnceWith(fallback);
    expect(vi.mocked(props.onSelectModel).mock.calls[0][0].provider).toBeUndefined();
  });

  it("groups models under provider headers only when more than one provider offers models", () => {
    const grouped = renderModels();
    expect(screen.getByText("Ollama")).toBeInTheDocument();
    expect(screen.getByText("MiniMax")).toBeInTheDocument();
    grouped.unmount();

    renderModels({ models: [qwen, llama] });
    expect(screen.queryByText("Ollama")).not.toBeInTheDocument();
    expect(screen.getByText("llama3.2:latest")).toBeInTheDocument();
  });

  it("toggling a provider header reports that provider's subsection key", async () => {
    const { props } = renderModels();

    await userEvent.click(screen.getByText("MiniMax"));

    expect(props.onToggleSubsection).toHaveBeenCalledExactlyOnceWith("model-MiniMax");
  });

  it("offers Model info only on the selected model", async () => {
    const { props } = renderModels();

    const infoButtons = screen.getAllByRole("button", { name: "Model info" });
    expect(infoButtons).toHaveLength(1);
    await userEvent.click(infoButtons[0]);

    expect(props.onOpenModelMeta).toHaveBeenCalledOnce();
    // Opening the metadata must not re-select the model.
    expect(props.onSelectModel).not.toHaveBeenCalled();
  });

  it("distinguishes the same model name on two providers by provider when marking the selection", () => {
    const remote: OllamaModel = { name: "qwen3:latest", provider: "remote", providerName: "Remote" };
    renderModels({ models: [qwen, remote], selectedModelKey: modelSelectKey("remote", "qwen3:latest") });

    const selected = screen.getAllByText("qwen3:latest").map((el) => el.closest(".MuiListItemButton-root")!)
      .map((item) => item.classList.contains("Mui-selected"));
    expect(selected).toEqual([false, true]);
  });

  it("the reasoning filters are mutually exclusive and narrow the list", async () => {
    renderModels();

    await userEvent.click(screen.getByText("reasoning only"));
    expect(screen.getByText("qwen3:latest")).toBeInTheDocument();
    expect(screen.queryByText("llama3.2:latest")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText("non-reasoning only"));
    expect(screen.queryByText("qwen3:latest")).not.toBeInTheDocument();
    expect(screen.getByText("llama3.2:latest")).toBeInTheDocument();
    expect(screen.getByText("MiniMax-M2")).toBeInTheDocument();

    await userEvent.click(screen.getByText("non-reasoning only"));
    expect(screen.getByText("qwen3:latest")).toBeInTheDocument();
  });

  it("search narrows the list by model name, case-insensitively", async () => {
    renderModels();

    await userEvent.type(screen.getByPlaceholderText("Search models…"), "LLAMA");

    expect(screen.getByText("llama3.2:latest")).toBeInTheDocument();
    expect(screen.queryByText("qwen3:latest")).not.toBeInTheDocument();
    expect(screen.queryByText("MiniMax")).not.toBeInTheDocument();
  });
});
