"use client";

import type { ReactNode } from "react";
import { Box, Collapse, ListItemButton, ListItemText, Typography } from "@mui/material";
import ExpandLessOutlinedIcon from "@mui/icons-material/ExpandLessOutlined";
import ExpandMoreOutlinedIcon from "@mui/icons-material/ExpandMoreOutlined";

interface SettingsSectionProps {
  title: string;
  /** The current value, shown in the header while the section is collapsed or open. */
  summary?: string;
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
  dataTour?: string;
  children: ReactNode;
}

/** A collapsible section of the settings sidebar. */
export function SettingsSection({ title, summary, open, onToggle, disabled, dataTour, children }: SettingsSectionProps) {
  return (
    <Box data-tour={dataTour}>
      <ListItemButton
        onClick={onToggle}
        sx={{ mx: -2, px: 2, py: 0.5 }}
        disabled={disabled}
      >
        <Typography variant="overline" color="text.secondary" sx={{ flexGrow: 1 }}>
          {title}
        </Typography>
        {summary !== undefined ? (
          <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
            {summary}
          </Typography>
        ) : null}
        {open ? <ExpandLessOutlinedIcon fontSize="small" /> : <ExpandMoreOutlinedIcon fontSize="small" />}
      </ListItemButton>
      <Collapse in={open}>
        {children}
      </Collapse>
    </Box>
  );
}

/** Header of a subsection (a provider or a tool source) inside a settings section. */
export function SubsectionHeader({ label, count, open, highlighted, onToggle, icon }: {
  label: string;
  count: number;
  open: boolean;
  /** The subsection contains the current selection. */
  highlighted: boolean;
  onToggle: () => void;
  icon?: ReactNode;
}) {
  return (
    <ListItemButton
      onClick={onToggle}
      selected={highlighted}
      sx={{ px: 1, py: 0.25, borderRadius: 1 }}
    >
      {icon}
      <ListItemText
        primary={label}
        primaryTypographyProps={{ variant: "caption", color: highlighted ? "primary" : "text.secondary", fontWeight: 600 }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
        {count}
      </Typography>
      {open ? <ExpandLessOutlinedIcon sx={{ fontSize: 14 }} /> : <ExpandMoreOutlinedIcon sx={{ fontSize: 14 }} />}
    </ListItemButton>
  );
}
