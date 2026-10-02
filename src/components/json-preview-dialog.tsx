"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Typography } from "@mui/material";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import { copyTextToClipboard } from "@/src/lib/clipboard";

export function JsonPreviewDialog({ open, onClose, title, subtitle, json, extra }: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle: string;
  json: string;
  extra?: ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    if (!open && copyState !== "idle") setCopyState("idle");
  }, [open, copyState]);

  async function handleCopy() {
    try {
      await copyTextToClipboard(json);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <Box>
          {title}
          <Typography variant="subtitle2" color="text.secondary">
            {subtitle}
          </Typography>
        </Box>
        <IconButton
          size="small"
          onClick={() => void handleCopy()}
          aria-label="Copy JSON"
          sx={{ opacity: 0.5, "&:hover": { opacity: 1 }, transition: "opacity 0.15s ease" }}
        >
          <ContentCopyOutlinedIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {copyState === "copied" ? (
          <Alert severity="success" sx={{ mb: 2 }}>JSON copied to clipboard.</Alert>
        ) : null}
        {copyState === "error" ? (
          <Alert severity="warning" sx={{ mb: 2 }}>Failed to copy JSON to clipboard.</Alert>
        ) : null}
        {extra}
        <Typography
          component="pre"
          variant="body2"
          sx={{ m: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace" }}
        >
          {json}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
