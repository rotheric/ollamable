"use client";

import { Box, Collapse, IconButton, ListItemButton, ListItemText, Paper, Stack, Typography } from "@mui/material";
import { alpha, useTheme, type Theme } from "@mui/material/styles";
import ExpandLessOutlinedIcon from "@mui/icons-material/ExpandLessOutlined";
import ExpandMoreOutlinedIcon from "@mui/icons-material/ExpandMoreOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import type { ConversationStep } from "@/src/types/chat";

interface StepCardProps {
  step: ConversationStep;
  expanded: boolean;
  onToggle: () => void;
  onInspect?: () => void;
  headerLabel: string;
  footerMeta?: React.ReactNode;
  footerActions?: React.ReactNode;
  children: React.ReactNode;
  dataTour?: string;
  bgColor?: string;
  onDoubleClickContent?: () => void;
}

export function StepCard({
  step,
  expanded,
  onToggle,
  onInspect,
  headerLabel,
  footerMeta,
  footerActions,
  children,
  dataTour,
  bgColor,
  onDoubleClickContent,
}: StepCardProps) {
  const theme = useTheme();
  const card = (
    <Paper
      data-step-kind={step.kind}
      data-tour={dataTour}
      sx={{
        overflow: "hidden",
        border: "1px solid",
        borderColor: "divider",
        backgroundColor: bgColor ?? getStepBackgroundColor(step.kind, theme),
      }}
    >
      <ListItemButton onClick={onToggle}>
        <ListItemText
          primary={headerLabel}
          primaryTypographyProps={{ variant: "body2", color: "text.secondary" }}
        />
        {onInspect ? (
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); onInspect(); }}
            sx={{ mr: 0.5 }}
            aria-label="Inspect OpenAI message"
          >
            <VisibilityOutlinedIcon fontSize="small" />
          </IconButton>
        ) : null}
        {expanded ? <ExpandLessOutlinedIcon/> : <ExpandMoreOutlinedIcon/>}
      </ListItemButton>
      <Collapse in={expanded}>
        <Box sx={{ p: 2.5, cursor: onDoubleClickContent ? "pointer" : undefined }} onDoubleClick={onDoubleClickContent}>
          {children}
          {(footerMeta || footerActions) ? (
            <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 1.5 }}>
              <Typography variant="body2" color="text.secondary" component="div" sx={{ flexGrow: 1 }}>
                {footerMeta}
              </Typography>
              {footerActions}
            </Stack>
          ) : null}
        </Box>
      </Collapse>
    </Paper>
  );

  return card;
}

export function getStepBackgroundColor(
  kind: ConversationStep["kind"],
  theme: Theme
) {
  if (theme.palette.mode === "dark") {
    switch (kind) {
      case "system":
        return alpha(theme.palette.info.dark, 0.28);
      case "user":
        return alpha(theme.palette.primary.dark, 0.24);
      case "assistant":
        return alpha(theme.palette.success.dark, 0.24);
      case "reasoning":
        return alpha(theme.palette.warning.dark, 0.2);
      case "tool_call":
        return alpha(theme.palette.error.dark, 0.14);
      case "tool_result":
        return alpha(theme.palette.error.dark, 0.22);
      case "meta":
        return alpha("#00bcd4", 0.15);
      case "compaction":
        return alpha(theme.palette.secondary.dark, 0.24);
      default:
        return alpha(theme.palette.background.paper, 0.9);
    }
  }

  switch (kind) {
    case "system":
      return alpha(theme.palette.info.light, 0.22);
    case "user":
      return alpha(theme.palette.primary.light, 0.18);
    case "assistant":
      return alpha(theme.palette.success.light, 0.2);
    case "reasoning":
      return alpha(theme.palette.warning.light, 0.22);
    case "tool_call":
      return alpha(theme.palette.error.light, 0.11);
    case "tool_result":
      return alpha(theme.palette.error.light, 0.18);
    case "meta":
      return alpha("#00bcd4", 0.12);
    case "compaction":
      return alpha(theme.palette.secondary.light, 0.18);
    default:
      return alpha(theme.palette.background.paper, 0.92);
  }
}
