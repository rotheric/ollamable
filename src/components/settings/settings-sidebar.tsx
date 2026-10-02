"use client";

import type { ReactNode } from "react";
import { Box, Checkbox, Chip, Divider, FormControlLabel, IconButton, Paper, Stack, Typography } from "@mui/material";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import { DEFAULT_MAX_MODEL_INVOCATIONS, DEFAULT_MAX_TOOL_CALLS } from "@/shared/execution-budget";
import type { Conversation, OllamaModel, ReasoningEffort } from "@/src/types/chat";
import { APP_BAR_HEIGHT, RIGHT_SIDEBAR_WIDTH, SIDEBAR_COLLAPSED_WIDTH } from "@/src/components/layout";
import { ModelsSection } from "@/src/components/settings/models-section";
import { SettingsSection } from "@/src/components/settings/settings-section";
import { ToolsSection } from "@/src/components/settings/tools-section";
import type { SidebarState } from "@/src/lib/chat";
import { isReasoningModel, modelSelectKey, supportsTemperature } from "@/src/lib/models";
import type { RightSectionKey } from "@/src/lib/use-sidebar-state";

const REASONING_EFFORT_OPTIONS: ReasoningEffort[] = ["disable", "low", "medium", "high"];
const TEMPERATURE_OPTIONS = [0.0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.0];
const MAX_OUTPUT_TOKEN_OPTIONS = [5, 10, 25, 50, 100, 250, 500, 1000];
const MODEL_INVOCATION_OPTIONS = [1, 2, 4, 8, 16, 32];
const TOOL_CALL_OPTIONS = [1, 4, 8, 16, 32, 64];

/** The request settings a conversation carries; `undefined` leaves a setting to the provider's default. */
type ConversationSettingsPatch = Partial<Pick<
  Conversation,
  "model" | "provider" | "temperature" | "maxOutputTokens" | "reasoningEffort" | "maxModelInvocations" | "maxToolCalls"
>>;

interface SettingsSidebarProps {
  conversation: Conversation | null;
  models: OllamaModel[];
  /** The conversation's model, when discovery knows it. */
  selectedModel: OllamaModel | undefined;
  sidebarState: SidebarState;
  onUpdateSidebar: (patch: Partial<SidebarState>) => void;
  onToggleSection: (key: RightSectionKey) => void;
  isSubsectionOpen: (key: string) => boolean;
  onToggleSubsection: (key: string) => void;
  onChangeSettings: (patch: ConversationSettingsPatch) => void;
  onToggleTool: (toolId: string) => void;
  onDisableAllTools: () => void;
  onOpenModelMeta: () => void;
}

/**
 * Right sidebar: the selected conversation's request settings (model, sampling,
 * execution budget, tools) and the client's display preferences.
 */
export function SettingsSidebar({
  conversation,
  models,
  selectedModel,
  sidebarState,
  onUpdateSidebar,
  onToggleSection,
  isSubsectionOpen,
  onToggleSubsection,
  onChangeSettings,
  onToggleTool,
  onDisableAllTools,
  onOpenModelMeta,
}: SettingsSidebarProps) {
  const { rightSidebarOpen } = sidebarState;
  const temperatureSupported = supportsTemperature(selectedModel);
  const reasoningEffortSupported = selectedModel ? isReasoningModel(selectedModel) : false;

  return (
    <Paper
      data-tour="right-sidebar"
      square
      onClick={rightSidebarOpen ? undefined : () => onUpdateSidebar({ rightSidebarOpen: true })}
      sx={{
        width: rightSidebarOpen ? RIGHT_SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH,
        minWidth: rightSidebarOpen ? RIGHT_SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH,
        flexShrink: 0,
        position: "sticky",
        top: APP_BAR_HEIGHT,
        alignSelf: "flex-start",
        height: `calc(100dvh - ${APP_BAR_HEIGHT}px)`,
        borderLeft: "1px solid",
        borderColor: "divider",
        backgroundColor: "var(--surface-sidebar)",
        overflow: "hidden",
        transition: "width 0.35s ease, min-width 0.35s ease",
        cursor: rightSidebarOpen ? "default" : "pointer",
      }}
    >
      <Box
        sx={{
          width: RIGHT_SIDEBAR_WIDTH,
          minWidth: RIGHT_SIDEBAR_WIDTH,
          height: "100%",
          py: 2,
          px: 1,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <Stack direction="row" alignItems="center">
          <IconButton
            size="small"
            onClick={() => onUpdateSidebar({ rightSidebarOpen: !rightSidebarOpen })}
            aria-label={rightSidebarOpen ? "Collapse tools sidebar" : "Expand tools sidebar"}
            sx={{ color: "text.secondary", transform: "scaleX(-1)" }}
          >
            <ViewSidebarOutlinedIcon />
          </IconButton>
          <Typography
            variant="overline"
            color="primary.light"
            sx={{
              flexGrow: 1,
              textAlign: "right",
              opacity: rightSidebarOpen ? 1 : 0,
              transition: rightSidebarOpen ? "opacity 0.2s ease 0.15s" : "opacity 0.1s ease",
            }}
          >
            Settings
          </Typography>
        </Stack>

        {conversation ? (
          <Box sx={{
            overflowY: "auto",
            overflowX: "hidden",
            flexGrow: 1,
            scrollbarGutter: "stable",
            pr: 1.5,
            opacity: rightSidebarOpen ? 1 : 0,
            transition: rightSidebarOpen ? "opacity 0.2s ease 0.15s" : "opacity 0.1s ease",
            pointerEvents: rightSidebarOpen ? "auto" : "none",
          }}>
            <Stack spacing={0.5}>
              <ModelsSection
                open={sidebarState.modelSectionOpen}
                onToggle={() => onToggleSection("modelSectionOpen")}
                models={models}
                selectedModelKey={modelSelectKey(conversation.provider, conversation.model)}
                isSubsectionOpen={isSubsectionOpen}
                onToggleSubsection={onToggleSubsection}
                onSelectModel={(model) => onChangeSettings({ model: model.name, provider: model.provider })}
                onOpenModelMeta={onOpenModelMeta}
              />

              <Divider />

              <SettingsSection
                title="Reasoning Effort"
                summary={reasoningEffortSupported && conversation.reasoningEffort ? conversation.reasoningEffort : ""}
                open={sidebarState.reasoningEffortSectionOpen}
                onToggle={() => onToggleSection("reasoningEffortSectionOpen")}
                disabled={!reasoningEffortSupported}
                dataTour="reasoning-effort-section"
              >
                <OptionChips
                  options={REASONING_EFFORT_OPTIONS}
                  selected={conversation.reasoningEffort}
                  onChange={(value) => onChangeSettings({ reasoningEffort: value })}
                  disabled={!reasoningEffortSupported}
                />
              </SettingsSection>

              <Divider />

              <SettingsSection
                title="Temperature"
                summary={conversation.temperature != null ? conversation.temperature.toFixed(1) : ""}
                open={sidebarState.tempSectionOpen}
                onToggle={() => onToggleSection("tempSectionOpen")}
                dataTour="temperature-section"
              >
                <OptionChips
                  options={TEMPERATURE_OPTIONS}
                  selected={conversation.temperature}
                  onChange={(value) => onChangeSettings({ temperature: value })}
                  formatLabel={(value) => value.toFixed(1)}
                  disabled={!temperatureSupported}
                />
              </SettingsSection>

              <Divider />

              <SettingsSection
                title="Max Output Tokens"
                summary={conversation.maxOutputTokens != null ? String(conversation.maxOutputTokens) : ""}
                open={sidebarState.maxTokensSectionOpen}
                onToggle={() => onToggleSection("maxTokensSectionOpen")}
                dataTour="max-tokens-section"
              >
                <OptionChips
                  options={MAX_OUTPUT_TOKEN_OPTIONS}
                  selected={conversation.maxOutputTokens}
                  onChange={(value) => onChangeSettings({ maxOutputTokens: value })}
                />
              </SettingsSection>

              <Divider />

              <SettingsSection
                title="Execution Budget"
                summary={conversation.maxModelInvocations != null || conversation.maxToolCalls != null
                  ? `${conversation.maxModelInvocations ?? DEFAULT_MAX_MODEL_INVOCATIONS} / ${conversation.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS}`
                  : ""}
                open={sidebarState.budgetSectionOpen}
                onToggle={() => onToggleSection("budgetSectionOpen")}
                dataTour="budget-section"
              >
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
                  Per request, before the server stops the tool loop. Unset uses {DEFAULT_MAX_MODEL_INVOCATIONS} model invocations and {DEFAULT_MAX_TOOL_CALLS} tool calls; the server may cap higher values.
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
                  Model invocations
                </Typography>
                <OptionChips
                  options={MODEL_INVOCATION_OPTIONS}
                  selected={conversation.maxModelInvocations}
                  onChange={(value) => onChangeSettings({ maxModelInvocations: value })}
                  ariaLabel="Max model invocations"
                />
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
                  Tool calls
                </Typography>
                <OptionChips
                  options={TOOL_CALL_OPTIONS}
                  selected={conversation.maxToolCalls}
                  onChange={(value) => onChangeSettings({ maxToolCalls: value })}
                  ariaLabel="Max tool calls"
                />
              </SettingsSection>

              <Divider />

              <ToolsSection
                open={sidebarState.toolsSectionOpen}
                onToggle={() => onToggleSection("toolsSectionOpen")}
                availableTools={conversation.availableTools}
                activeToolIds={conversation.activeToolIds}
                isSubsectionOpen={isSubsectionOpen}
                onToggleSubsection={onToggleSubsection}
                onToggleTool={onToggleTool}
                onDisableAllTools={onDisableAllTools}
              />

              <Divider />

              <SettingsSection
                title="Client"
                open={sidebarState.clientSectionOpen}
                onToggle={() => onToggleSection("clientSectionOpen")}
              >
                <Stack sx={{ mt: 0.5 }}>
                  <Preference label="Render markdown" name="renderMarkdown" state={sidebarState} onUpdate={onUpdateSidebar} />
                  <Preference label="Show tokens" name="showTokens" state={sidebarState} onUpdate={onUpdateSidebar} />
                  <Preference label="Show examples" name="showExamples" state={sidebarState} onUpdate={onUpdateSidebar} />
                  <Preference label="Show tour" name="showTour" state={sidebarState} onUpdate={onUpdateSidebar} />

                  <PreferenceGroupLabel>Hide</PreferenceGroupLabel>
                  <Preference label="System prompt" name="hideSystemPrompt" state={sidebarState} onUpdate={onUpdateSidebar} />

                  <PreferenceGroupLabel>Collapse by default</PreferenceGroupLabel>
                  <Preference label="Reasoning" name="collapseReasoning" state={sidebarState} onUpdate={onUpdateSidebar} />
                  <Preference label="Tool calls" name="collapseToolCalls" state={sidebarState} onUpdate={onUpdateSidebar} />
                  <Preference label="Tools" name="collapseTools" state={sidebarState} onUpdate={onUpdateSidebar} />
                  <Preference label="Server / harness messages" name="collapseServerMessages" state={sidebarState} onUpdate={onUpdateSidebar} />
                </Stack>
              </SettingsSection>
            </Stack>
          </Box>
        ) : null}
      </Box>
    </Paper>
  );
}

/** A row of mutually exclusive option chips; clicking the selected one clears the setting. */
function OptionChips<T extends string | number>({ options, selected, onChange, formatLabel, disabled, ariaLabel }: {
  options: T[];
  selected: T | undefined;
  onChange: (value: T | undefined) => void;
  formatLabel?: (value: T) => string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }} aria-label={ariaLabel}>
      {options.map((val) => (
        <Chip
          key={val}
          label={formatLabel ? formatLabel(val) : val}
          size="small"
          variant={selected === val ? "filled" : "outlined"}
          color={selected === val ? "primary" : "default"}
          clickable
          onClick={() => onChange(selected === val ? undefined : val)}
          disabled={disabled}
        />
      ))}
    </Stack>
  );
}

type BooleanPreference = {
  [K in keyof SidebarState]: SidebarState[K] extends boolean ? K : never;
}[keyof SidebarState];

function Preference({ label, name, state, onUpdate }: {
  label: string;
  name: BooleanPreference;
  state: SidebarState;
  onUpdate: (patch: Partial<SidebarState>) => void;
}) {
  return (
    <FormControlLabel
      control={
        <Checkbox
          checked={state[name]}
          onChange={() => onUpdate({ [name]: !state[name] })}
          size="small"
        />
      }
      label={<Typography variant="body2">{label}</Typography>}
    />
  );
}

function PreferenceGroupLabel({ children }: { children: ReactNode }) {
  return (
    <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, mb: 0.5 }}>
      {children}
    </Typography>
  );
}
