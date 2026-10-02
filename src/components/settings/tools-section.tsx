"use client";

import { useMemo, useState } from "react";
import { Box, Checkbox, Chip, Collapse, FormControlLabel, Paper, Stack, Typography } from "@mui/material";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import type { ToolDefinition } from "@/src/types/chat";
import { SectionSearchField } from "@/src/components/settings/section-search-field";
import { SettingsSection, SubsectionHeader } from "@/src/components/settings/settings-section";

/** MCP tool ids are `mcp-<server>-<tool>`; everything else is built into the backend. */
const MCP_TOOL_ID = /^mcp-(.+?)-/;

/** Sidebar subsection a tool is listed under. */
export function toolSubsectionKey(toolId: string): string {
  const mcpMatch = toolId.match(MCP_TOOL_ID);
  return mcpMatch ? `tools-mcp-${mcpMatch[1]}` : "tools-builtin";
}

interface ToolsSectionProps {
  open: boolean;
  onToggle: () => void;
  availableTools: ToolDefinition[];
  activeToolIds: string[];
  isSubsectionOpen: (key: string) => boolean;
  onToggleSubsection: (key: string) => void;
  onToggleTool: (toolId: string) => void;
  onDisableAllTools: () => void;
}

/** Per-conversation tool selection: built-in tools, then one subsection per MCP server. */
export function ToolsSection({
  open,
  onToggle,
  availableTools,
  activeToolIds,
  isSubsectionOpen,
  onToggleSubsection,
  onToggleTool,
  onDisableAllTools,
}: ToolsSectionProps) {
  const [toolSearch, setToolSearch] = useState("");
  const [toolFilterActive, setToolFilterActive] = useState(false);

  const toolSearchLower = toolSearch.toLowerCase();
  const hasToolFilter = toolFilterActive || Boolean(toolSearchLower);

  const { builtinTools, mcpServers } = useMemo(() => {
    const builtinTools: ToolDefinition[] = [];
    const mcpServers = new Map<string, ToolDefinition[]>();
    for (const tool of availableTools) {
      if (toolSearchLower && !tool.name.toLowerCase().includes(toolSearchLower)) continue;
      if (toolFilterActive && !activeToolIds.includes(tool.id)) continue;
      const serverName = tool.id.match(MCP_TOOL_ID)?.[1];
      if (serverName === undefined) {
        // Any other `mcp-` id is not a built-in tool either.
        if (!tool.id.startsWith("mcp-")) builtinTools.push(tool);
        continue;
      }
      const group = mcpServers.get(serverName) ?? [];
      group.push(tool);
      mcpServers.set(serverName, group);
    }
    return { builtinTools, mcpServers };
  }, [availableTools, activeToolIds, toolSearchLower, toolFilterActive]);

  // The guided tour points at the first tool card, wherever it is listed.
  const tourToolId = builtinTools[0]?.id ?? mcpServers.values().next().value?.[0]?.id;

  function renderTool(tool: ToolDefinition) {
    return (
      <Paper key={tool.id} data-tool-id={tool.id} {...(tool.id === tourToolId ? { "data-tour": "tool-card" } : {})} variant="outlined" sx={{ p: 1.5 }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={activeToolIds.includes(tool.id)}
              onChange={() => onToggleTool(tool.id)}
              size="small"
            />
          }
          label={
            <Box>
              <Typography variant="body2" fontWeight={700}>{tool.name}</Typography>
              <Typography variant="caption" color="text.secondary">
                {tool.description}
              </Typography>
            </Box>
          }
          sx={{ alignItems: "flex-start", m: 0 }}
        />
        <ToolSchema tool={tool} />
      </Paper>
    );
  }

  function renderSubsection(key: string, label: string, tools: ToolDefinition[], isMcpServer: boolean) {
    const hasActiveTool = tools.some((t) => activeToolIds.includes(t.id));
    // Force-expand subsections when a filter or search is active
    const subsectionOpen = hasToolFilter || isSubsectionOpen(key);
    return (
      <Box key={key}>
        <SubsectionHeader
          label={label}
          count={tools.length}
          open={subsectionOpen}
          highlighted={hasActiveTool}
          onToggle={() => onToggleSubsection(key)}
          icon={isMcpServer ? (
            <HubOutlinedIcon sx={{ fontSize: 14, mr: 0.5, color: hasActiveTool ? "primary.main" : "text.secondary" }} />
          ) : undefined}
        />
        <Collapse in={subsectionOpen}>
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {tools.map(renderTool)}
          </Stack>
        </Collapse>
      </Box>
    );
  }

  return (
    <SettingsSection title="Tools" open={open} onToggle={onToggle} dataTour="tools-section">
      <Stack data-tour="tool-search" spacing={0.5} sx={{ mt: 0.5 }}>
        <SectionSearchField value={toolSearch} onChange={setToolSearch} placeholder="Search tools…" />
        <Stack direction="row" spacing={0.5} sx={{ mb: 0.5 }}>
          <Chip
            label="show active only"
            size="small"
            variant={toolFilterActive ? "filled" : "outlined"}
            color={toolFilterActive ? "primary" : "default"}
            clickable
            onClick={() => setToolFilterActive((prev) => !prev)}
          />
          <Chip
            label="disable all"
            size="small"
            variant="outlined"
            clickable
            disabled={activeToolIds.length === 0}
            onClick={onDisableAllTools}
          />
        </Stack>
        {renderSubsection("tools-builtin", "built-in", builtinTools, false)}
        {Array.from(mcpServers.entries()).map(([serverName, serverTools]) =>
          renderSubsection(`tools-mcp-${serverName}`, serverName, serverTools, true)
        )}
      </Stack>
    </SettingsSection>
  );
}

/** The tool's parameters as a table, or its raw schema when that is not JSON. */
function ToolSchema({ tool }: { tool: ToolDefinition }) {
  let props: Record<string, { type?: string; description?: string } | null> | undefined;
  let required: string[];
  try {
    const schema = JSON.parse(tool.inputSchema) as { properties?: typeof props; required?: string[] };
    props = schema.properties;
    required = schema.required ?? [];
  } catch {
    return (
      <Typography variant="caption" sx={{ mt: 1, display: "block", whiteSpace: "pre-wrap", fontFamily: "monospace", color: "text.secondary" }}>
        {tool.inputSchema}
      </Typography>
    );
  }

  if (!props || Object.keys(props).length === 0) return null;
  return (
    <Box sx={{ mt: 1, overflow: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "2px 8px 2px 0", color: "gray" }}>Property</th>
            <th style={{ textAlign: "left", padding: "2px 8px", color: "gray" }}>Type</th>
            <th style={{ textAlign: "center", padding: "2px 4px", color: "gray" }}>Req</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(props).map(([name, def]) => (
            <tr key={name}>
              <td style={{ padding: "2px 8px 2px 0", fontFamily: "monospace" }}>{name}</td>
              <td style={{ padding: "2px 8px", fontFamily: "monospace", color: "gray" }}>{def?.type ?? "—"}</td>
              <td style={{ textAlign: "center", padding: "2px 4px" }}>
                <Checkbox checked={required.includes(name)} size="small" disabled sx={{ p: 0 }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Box>
  );
}
