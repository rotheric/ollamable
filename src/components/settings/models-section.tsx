"use client";

import { useState, type ReactNode } from "react";
import { Chip, Collapse, IconButton, List, ListItemButton, ListItemText, Stack } from "@mui/material";
import MemoryOutlinedIcon from "@mui/icons-material/MemoryOutlined";
import type { OllamaModel } from "@/src/types/chat";
import { SectionSearchField } from "@/src/components/settings/section-search-field";
import { SettingsSection, SubsectionHeader } from "@/src/components/settings/settings-section";
import { groupModelsByProviderName, isReasoningModel, modelSelectKey } from "@/src/lib/models";

interface ModelsSectionProps {
  open: boolean;
  onToggle: () => void;
  models: OllamaModel[];
  /** `modelSelectKey` of the conversation's model. */
  selectedModelKey: string;
  isSubsectionOpen: (key: string) => boolean;
  onToggleSubsection: (key: string) => void;
  onSelectModel: (model: OllamaModel) => void;
  onOpenModelMeta: () => void;
}

/** Model picker, grouped by provider once more than one provider offers models. */
export function ModelsSection({
  open,
  onToggle,
  models,
  selectedModelKey,
  isSubsectionOpen,
  onToggleSubsection,
  onSelectModel,
  onOpenModelMeta,
}: ModelsSectionProps) {
  const [modelSearch, setModelSearch] = useState("");
  const [modelFilterReasoning, setModelFilterReasoning] = useState(false);
  const [modelFilterNonReasoning, setModelFilterNonReasoning] = useState(false);

  const modelSearchLower = modelSearch.toLowerCase();
  const hasModelFilter = modelFilterReasoning || modelFilterNonReasoning || Boolean(modelSearchLower);
  const filtered = models.filter((m) => {
    if (modelSearchLower && !m.name.toLowerCase().includes(modelSearchLower)) return false;
    if (modelFilterReasoning && !isReasoningModel(m)) return false;
    if (modelFilterNonReasoning && isReasoningModel(m)) return false;
    return true;
  });
  const providers = groupModelsByProviderName(filtered);

  function renderModel(model: OllamaModel, nested: boolean) {
    const value = modelSelectKey(model.provider, model.name);
    const isSelected = value === selectedModelKey;
    return (
      <ListItemButton
        key={value}
        selected={isSelected}
        onClick={() => onSelectModel(model)}
        sx={nested ? { borderRadius: 2, py: 0.25, px: 1, pl: 2 } : { borderRadius: 2, py: 0.25, px: 1 }}
      >
        <ListItemText
          primary={renderModelLabel(model)}
          primaryTypographyProps={{ variant: "body2" }}
        />
        {isSelected ? (
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onOpenModelMeta();
            }}
            aria-label="Model info"
          >
            <MemoryOutlinedIcon fontSize="small" />
          </IconButton>
        ) : null}
      </ListItemButton>
    );
  }

  const items: ReactNode[] = [];
  for (const [providerName, group] of providers) {
    if (providers.size <= 1) {
      // With a single provider the subsection headers would only add noise.
      items.push(...group.map((model) => renderModel(model, false)));
      continue;
    }
    const subsectionKey = `model-${providerName}`;
    // Force-expand subsections when a filter or search is active
    const subsectionOpen = hasModelFilter || isSubsectionOpen(subsectionKey);
    items.push(
      <SubsectionHeader
        key={`header-${providerName}`}
        label={providerName}
        count={group.length}
        open={subsectionOpen}
        highlighted={group.some((m) => modelSelectKey(m.provider, m.name) === selectedModelKey)}
        onToggle={() => onToggleSubsection(subsectionKey)}
      />
    );
    items.push(
      <Collapse key={`collapse-${providerName}`} in={subsectionOpen}>
        {group.map((model) => renderModel(model, true))}
      </Collapse>
    );
  }

  return (
    <SettingsSection title="Models" open={open} onToggle={onToggle} dataTour="models-section">
      <SectionSearchField value={modelSearch} onChange={setModelSearch} placeholder="Search models…" dataTour="model-search" />
      <Stack direction="row" spacing={0.5} sx={{ mb: 0.5 }}>
        <Chip
          data-tour="model-filter-reasoning"
          label="reasoning only"
          size="small"
          variant={modelFilterReasoning ? "filled" : "outlined"}
          color={modelFilterReasoning ? "primary" : "default"}
          clickable
          onClick={() => { setModelFilterReasoning((prev) => !prev); setModelFilterNonReasoning(false); }}
        />
        <Chip
          label="non-reasoning only"
          size="small"
          variant={modelFilterNonReasoning ? "filled" : "outlined"}
          color={modelFilterNonReasoning ? "primary" : "default"}
          clickable
          onClick={() => { setModelFilterNonReasoning((prev) => !prev); setModelFilterReasoning(false); }}
        />
      </Stack>
      <List dense sx={{ p: 0, mt: 0.5 }}>
        {items}
      </List>
    </SettingsSection>
  );
}

function renderModelLabel(model: OllamaModel) {
  return (
    <span style={{ display: "flex", gap: "6px" }}>
      <span style={{ width: "1.2em", flexShrink: 0, textAlign: "center" }}>
        {isReasoningModel(model) ? "✨" : ""}
      </span>
      <span>{model.name}</span>
    </span>
  );
}
