"use client";

import { AppBar, Box, Chip, IconButton, Toolbar, Typography } from "@mui/material";
import GitHubIcon from "@mui/icons-material/GitHub";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import MemoryOutlinedIcon from "@mui/icons-material/MemoryOutlined";
import PsychologyOutlinedIcon from "@mui/icons-material/PsychologyOutlined";
import ThermostatOutlinedIcon from "@mui/icons-material/ThermostatOutlined";
import TokenOutlinedIcon from "@mui/icons-material/TokenOutlined";
import type { Conversation, OllamaModel } from "@/src/types/chat";
import { ColorModeToggle } from "@/src/components/color-mode-toggle";
import { APP_BAR_HEIGHT } from "@/src/components/layout";
import { isReasoningModel } from "@/src/lib/models";
import type { RightSectionKey } from "@/src/lib/use-sidebar-state";

interface WorkspaceAppBarProps {
  conversation: Conversation | null;
  /** The selected conversation's model, when discovery knows it. */
  model: OllamaModel | undefined;
  onOpenSection: (key: RightSectionKey, subsectionKey?: string) => void;
}

/** Title bar. Its chips summarize the conversation's settings and jump to the matching sidebar section. */
export function WorkspaceAppBar({ conversation, model, onOpenSection }: WorkspaceAppBarProps) {
  const selectedTemperature = conversation?.temperature;
  const selectedReasoningEffort = conversation?.reasoningEffort;
  const reasoningEffortSupported = model ? isReasoningModel(model) : false;

  return (
    <AppBar
      data-tour="appbar"
      position="sticky"
      color="transparent"
      elevation={0}
      sx={{
        backdropFilter: "blur(18px)",
        borderBottom: "1px solid",
        borderColor: "divider",
        backgroundColor: "var(--surface-appbar)",
      }}
    >
      <Toolbar sx={{ gap: 2, px: { xs: 2, sm: 2 }, minHeight: APP_BAR_HEIGHT }}>
        <HubOutlinedIcon />
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6">Ollamable</Typography>
          <Typography variant="body2" color="text.secondary">
            Step-level local chat visualization of LLM sessions
          </Typography>
        </Box>
        {conversation ? (
          <>
            <Chip
              data-tour="model-chip"
              icon={<MemoryOutlinedIcon />}
              label={conversation.model}
              color="primary"
              clickable
              onClick={() => onOpenSection("modelSectionOpen", `model-${model?.providerName ?? "Local"}`)}
              aria-label={`Open model settings for ${conversation.model}`}
              size="small"
            />
            {selectedTemperature != null ? (
              <Chip
                icon={<ThermostatOutlinedIcon />}
                label={selectedTemperature.toFixed(1)}
                color="primary"
                clickable
                onClick={() => onOpenSection("tempSectionOpen")}
                aria-label="Open temperature settings"
                size="small"
              />
            ) : null}
            {conversation.maxOutputTokens != null ? (
              <Chip
                icon={<TokenOutlinedIcon />}
                label={conversation.maxOutputTokens}
                color="primary"
                clickable
                onClick={() => onOpenSection("maxTokensSectionOpen")}
                aria-label="Open max output tokens settings"
                size="small"
              />
            ) : null}
            {selectedReasoningEffort != null && reasoningEffortSupported ? (
              <Chip
                icon={<PsychologyOutlinedIcon />}
                label={selectedReasoningEffort}
                color="primary"
                clickable
                onClick={() => onOpenSection("reasoningEffortSectionOpen")}
                aria-label="Open reasoning effort settings"
                size="small"
              />
            ) : null}
          </>
        ) : null}
        <Box data-tour="color-mode-toggle">
          <ColorModeToggle />
        </Box>
        <IconButton
          size="small"
          component="a"
          href="https://github.com/mustwork/ollamable"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub repository"
          sx={{ color: "text.secondary" }}
        >
          <GitHubIcon fontSize="small" />
        </IconButton>
      </Toolbar>
    </AppBar>
  );
}
