"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type { OllamaModel, OllamaModelMeta } from "@/src/types/chat";
import { fetchModelMeta } from "@/src/lib/ollama";

/** Loads a model's metadata on demand and holds what the dialog below displays. */
export function useModelMeta() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [meta, setMeta] = useState<OllamaModelMeta | null>(null);

  async function show(model: OllamaModel) {
    setOpen(true);
    setLoading(true);
    setError("");
    setMeta(null);

    try {
      const nextMeta = await fetchModelMeta(model);
      setMeta(nextMeta);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load model metadata."
      );
    } finally {
      setLoading(false);
    }
  }

  return { open, loading, error, meta, show, close: () => setOpen(false) };
}

interface ModelMetaDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  loading: boolean;
  error: string;
  meta: OllamaModelMeta | null;
}

export function ModelMetaDialog({ open, onClose, title, loading: modelMetaLoading, error: modelMetaError, meta: modelMeta }: ModelMetaDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          {modelMetaLoading ? (
            <Stack direction="row" spacing={1.5} alignItems="center">
              <CircularProgress size={18} aria-label="Loading model metadata" />
              <Typography color="text.secondary">
                Loading metadata from Ollama
              </Typography>
            </Stack>
          ) : null}

          {modelMetaError ? <Alert severity="warning">{modelMetaError}</Alert> : null}

          {modelMeta ? (
            <>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {renderMetaChip("Family", modelMeta.family)}
                {renderMetaChip("Parameters", modelMeta.parameterSize)}
                {renderMetaChip("Format", modelMeta.format)}
                {renderMetaChip("Quantization", modelMeta.quantizationLevel)}
                {renderMetaChip("Parent", modelMeta.parentModel)}
              </Stack>

              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="overline" color="primary.light">
                  Summary
                </Typography>
                <Typography variant="body2" sx={{ mt: 1, whiteSpace: "pre-wrap" }}>
                  {formatKeyValueSummary(modelMeta)}
                </Typography>
              </Paper>

              {modelMeta.capabilities?.length ? (
                <Paper variant="outlined" sx={{ p: 2 }}>
                  <Typography variant="overline" color="primary.light">
                    Capabilities
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                    {modelMeta.capabilities.map((capability) => (
                      <Chip key={capability} size="small" label={capability} variant="outlined" />
                    ))}
                  </Stack>
                </Paper>
              ) : null}

              {renderJsonSection("Details", modelMeta.details)}
              {renderJsonSection("Model Info", modelMeta.modelInfo)}
              {renderTextSection("Parameters", modelMeta.parameters)}
              {renderTextSection("System", modelMeta.system)}
              {renderTextSection("Template", modelMeta.template)}
              {renderTextSection("License", modelMeta.license)}
            </>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function renderMetaChip(label: string, value?: string) {
  if (!value) {
    return null;
  }

  return <Chip size="small" variant="outlined" label={`${label}: ${value}`} />;
}

function renderTextSection(label: string, value?: string) {
  if (!value?.trim()) {
    return null;
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="overline" color="primary.light">
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{ mt: 1, whiteSpace: "pre-wrap", fontFamily: "monospace" }}
      >
        {value}
      </Typography>
    </Paper>
  );
}

function renderJsonSection(
  label: string,
  value?: Record<string, string | number | boolean | string[] | undefined>
) {
  if (!value || Object.keys(value).length === 0) {
    return null;
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="overline" color="primary.light">
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{ mt: 1, whiteSpace: "pre-wrap", fontFamily: "monospace" }}
      >
        {JSON.stringify(value, null, 2)}
      </Typography>
    </Paper>
  );
}

function formatKeyValueSummary(modelMeta: OllamaModelMeta) {
  const entries = [
    ["Name", modelMeta.name],
    ["Modified", modelMeta.modifiedAt],
    ["Family", modelMeta.family],
    ["Families", modelMeta.families?.join(", ")],
    ["Parameter size", modelMeta.parameterSize],
    ["Format", modelMeta.format],
    ["Quantization", modelMeta.quantizationLevel],
    ["Parent", modelMeta.parentModel],
  ].filter(([, value]) => Boolean(value));

  return entries.map(([key, value]) => `${key}: ${value}`).join("\n");
}
