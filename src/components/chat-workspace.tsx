"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Joyride, ACTIONS, EVENTS, STATUS, type EventData } from "react-joyride";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Alert,
  AppBar,
  Badge,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  ListSubheader,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Toolbar,
  Typography,
} from "@mui/material";
import { alpha, useTheme, type Theme } from "@mui/material/styles";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import GitHubIcon from "@mui/icons-material/GitHub";
import ExpandLessOutlinedIcon from "@mui/icons-material/ExpandLessOutlined";
import ExpandMoreOutlinedIcon from "@mui/icons-material/ExpandMoreOutlined";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import MemoryOutlinedIcon from "@mui/icons-material/MemoryOutlined";
import PlayArrowOutlinedIcon from "@mui/icons-material/PlayArrowOutlined";
import PsychologyOutlinedIcon from "@mui/icons-material/PsychologyOutlined";
import ReplayOutlinedIcon from "@mui/icons-material/ReplayOutlined";
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import StopOutlinedIcon from "@mui/icons-material/StopOutlined";
import ThermostatOutlinedIcon from "@mui/icons-material/ThermostatOutlined";
import TokenOutlinedIcon from "@mui/icons-material/TokenOutlined";
import TourOutlinedIcon from "@mui/icons-material/TourOutlined";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import type { Conversation, ConversationStep, OllamaModel, OllamaModelMeta, ReasoningEffort, StepKind, ToolCallPayload, ToolDefinition } from "@/src/types/chat";
import { ColorModeToggle } from "@/src/components/color-mode-toggle";
import {
  createConversation,
  createStep,
  ensureConversationTools,
  fallbackModels,
  formatTimestamp,
  inferTitle,
  loadConversations,
  loadConversationOrder,
  loadSelectedConversationId,
  loadSidebarState,
  saveConversations,
  saveConversationOrder,
  saveSelectedConversationId,
  saveSidebarState,
  SYSTEM_PROMPT_EXAMPLES,
} from "@/src/lib/chat";
import type { SidebarState } from "@/src/lib/chat";
import {
  fetchAllModels,
  fetchModelMeta,
  fetchTools,
} from "@/src/lib/ollama";
import { useWebSocket } from "@/src/lib/use-websocket";
import { BackendClient, WS_URL } from "@/src/lib/backend-client";
import { TokenViewStepContent } from "@/src/components/token-view-step-content";
import { buildOpenAIRequestBody, toOpenAIMessages } from "@/shared/openai-format";
import {
  tourSteps,
  createTourConversations,
  TOUR_COMPLETED_KEY,
  TOUR_STEP_KEY,
} from "@/src/lib/tour-data";

const SIDEBAR_WIDTH = 320;
const APP_BAR_HEIGHT = 65;
const SIDEBAR_COLLAPSED_WIDTH = 44;
const RIGHT_SIDEBAR_WIDTH = 360;
const TEMPERATURE_OPTIONS = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 2.0];
const REASONING_EFFORT_OPTIONS: ReasoningEffort[] = ["disable", "low", "medium", "high"];

interface SortableConversationCardProps {
  conversation: Conversation;
  index: number;
  isSelected: boolean;
  isEditingTitle: boolean;
  isEditingNote: boolean;
  titleDraft: string;
  noteDraft: string;
  onSelect: () => void;
  onViewJson: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onTitleChange: (value: string) => void;
  onTitleSave: () => void;
  onTitleCancel: () => void;
  onTitleEdit: () => void;
  onNoteChange: (value: string) => void;
  onNoteSave: () => void;
  onNoteEdit: () => void;
}

function SortableConversationCard({
  conversation,
  index,
  isSelected,
  isEditingTitle,
  isEditingNote,
  titleDraft,
  noteDraft,
  onSelect,
  onViewJson,
  onDelete,
  onTitleChange,
  onTitleSave,
  onTitleCancel,
  onTitleEdit,
  onNoteChange,
  onNoteSave,
  onNoteEdit,
}: SortableConversationCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: conversation.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <Paper
      ref={setNodeRef}
      style={style}
      variant="outlined"
      {...(index === 0 ? { "data-tour": "conversation-card" } : {})}
      sx={{
        mb: 0.5,
        p: 1.5,
        cursor: "pointer",
        position: "relative",
        "&:hover .conversation-actions": { opacity: 1 },
        "&:hover .drag-handle": { opacity: 1 },
        ...(isSelected
          ? {
              borderColor: "primary.main",
              bgcolor: "action.selected",
            }
          : {}),
      }}
      onClick={onSelect}
    >
      <Box
        className="drag-handle"
        {...attributes}
        {...listeners}
        sx={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: 0,
          transition: "opacity 0.15s ease",
          cursor: "grab",
          color: "text.disabled",
          "&:active": { cursor: "grabbing" },
        }}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <DragIndicatorIcon sx={{ fontSize: 14 }} />
      </Box>
      <IconButton
        className="conversation-actions"
        size="small"
        onClick={onViewJson}
        aria-label="View request JSON"
        sx={{ position: "absolute", top: 4, right: 4, opacity: 0, transition: "opacity 0.15s ease" }}
      >
        <VisibilityOutlinedIcon sx={{ fontSize: 14 }} />
      </IconButton>
      <IconButton
        className="conversation-actions"
        size="small"
        onClick={onDelete}
        aria-label={`Delete conversation ${conversation.title}`}
        sx={{ position: "absolute", bottom: 4, right: 4, opacity: 0, transition: "opacity 0.15s ease" }}
      >
        <DeleteOutlinedIcon sx={{ fontSize: 14 }} />
      </IconButton>
      {isEditingTitle ? (
        <input
          value={titleDraft}
          onChange={(event) => onTitleChange(event.target.value)}
          onBlur={onTitleSave}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onTitleSave();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onTitleCancel();
            }
          }}
          onClick={(event) => event.stopPropagation()}
          autoFocus
          style={{
            font: "inherit",
            fontSize: "0.875rem",
            fontWeight: 600,
            lineHeight: 1.43,
            letterSpacing: "0.01071em",
            color: "inherit",
            background: "none",
            border: "none",
            outline: "none",
            padding: 0,
            margin: 0,
            width: "100%",
            boxSizing: "border-box",
            height: "1.25rem",
          }}
        />
      ) : (
        <Typography
          variant="body2"
          fontWeight={600}
          onClick={(e) => {
            if (isSelected) {
              e.stopPropagation();
              onTitleEdit();
            }
          }}
          sx={{
            cursor: isSelected ? "text" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            "& .edit-pencil": { opacity: 0, transition: "opacity 0.15s ease" },
            "&:hover .edit-pencil": { opacity: 1 },
          }}
        >
          {conversation.title}
          {isSelected && (
            <EditOutlinedIcon className="edit-pencil" sx={{ fontSize: 12, color: "text.secondary", flexShrink: 0 }} />
          )}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
        {(() => {
          const msgs = conversation.steps.filter((s) => s.kind === "user" || s.kind === "assistant").length;
          const input = conversation.steps.reduce((sum, s) => sum + (s.usage?.inputTokens ?? 0), 0);
          const output = conversation.steps.reduce((sum, s) => sum + (s.usage?.outputTokens ?? 0), 0);
          const tokens = input + output;
          return <>{msgs} messages • {formatTimestamp(conversation.updatedAt)}{tokens > 0 ? <><br />{tokens.toLocaleString()} tokens</> : null}</>;
        })()}
      </Typography>
      {isSelected && (
        isEditingNote || !conversation.note ? (
          <textarea
            value={noteDraft}
            onChange={(e) => onNoteChange(e.target.value)}
            onBlur={onNoteSave}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onNoteSave();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus={isEditingNote}
            rows={2}
            placeholder="Add a note..."
            style={{
              font: "inherit",
              fontSize: "0.75rem",
              lineHeight: 1.4,
              color: "inherit",
              background: "rgba(128,128,128,0.1)",
              border: "1px solid rgba(128,128,128,0.3)",
              borderRadius: 4,
              outline: "none",
              padding: 6,
              marginTop: 4,
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
            }}
          />
        ) : (
          <Typography
            variant="caption"
            color="text.secondary"
            onClick={(e) => { e.stopPropagation(); onNoteEdit(); }}
            sx={{
              mt: 0.5,
              display: "flex",
              alignItems: "flex-start",
              gap: 0.5,
              fontStyle: "italic",
              cursor: "text",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              "& .edit-pencil": { opacity: 0, transition: "opacity 0.15s ease" },
              "&:hover .edit-pencil": { opacity: 1 },
            }}
          >
            {conversation.note}
            <EditOutlinedIcon className="edit-pencil" sx={{ fontSize: 12, color: "text.secondary", flexShrink: 0, mt: "2px" }} />
          </Typography>
        )
      )}
    </Paper>
  );
}

export function ChatWorkspace() {
  const theme = useTheme();
  const [models, setModels] = useState<OllamaModel[]>(fallbackModels);
  const modelsRef = useRef<OllamaModel[]>(fallbackModels);
  modelsRef.current = models;
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationOrder, setConversationOrder] = useState<string[] | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string>("");
  const [composerValue, setComposerValue] = useState("");
  const [toolSearch, setToolSearch] = useState("");
  const [toolFilterActive, setToolFilterActive] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelFilterReasoning, setModelFilterReasoning] = useState(false);
  const [modelFilterNonReasoning, setModelFilterNonReasoning] = useState(false);
  const [sidebarState, setSidebarState] = useState<SidebarState>({
    sidebarOpen: true,
    rightSidebarOpen: false,
    modelSectionOpen: false,
    reasoningEffortSectionOpen: false,
    tempSectionOpen: false,
    maxTokensSectionOpen: false,
    toolsSectionOpen: false,
    clientSectionOpen: false,
    renderMarkdown: true,
    showTokens: false,
    showTour: true,
    showExamples: true,
    collapseReasoning: false,
    collapseToolCalls: false,
    collapseTools: true,
    collapseServerMessages: false,
    hideSystemPrompt: false,
    subsections: {},
  });

  // Load persisted sidebar state on mount
  useEffect(() => {
    setSidebarState(loadSidebarState());
  }, []);

  const updateSidebar = useCallback((patch: Partial<SidebarState>) => {
    setSidebarState((prev) => {
      const next = { ...prev, ...patch };
      saveSidebarState(next);
      return next;
    });
  }, []);

  const {
    sidebarOpen,
    rightSidebarOpen,
    modelSectionOpen,
    reasoningEffortSectionOpen,
    tempSectionOpen,
    maxTokensSectionOpen,
    toolsSectionOpen,
    clientSectionOpen,
    renderMarkdown,
    showTokens,
    showTour,
    showExamples,
    collapseReasoning,
    collapseToolCalls,
    collapseTools,
    collapseServerMessages,
    hideSystemPrompt,
    subsections,
  } = sidebarState;

  const sidebarRef = useRef(sidebarState);
  sidebarRef.current = sidebarState;

  const defaultExpanded = useCallback((step: ConversationStep): boolean => {
    const s = sidebarRef.current;
    const kind = step.kind;
    if (kind === "reasoning" && s.collapseReasoning) return false;
    if (kind === "tool_call" && s.collapseTools) return false;
    if (kind === "tool_result" && s.collapseToolCalls) return false;
    if (kind === "assistant" && step.toolCalls?.length && s.collapseToolCalls) return false;
    if (kind === "meta" && s.collapseServerMessages) return false;
    return true;
  }, []);

  const isSubsectionOpen = useCallback(
    (key: string) => subsections[key] ?? false,
    [subsections]
  );

  const toggleSubsection = useCallback(
    (key: string) => {
      setSidebarState((prev) => {
        const opening = !(prev.subsections[key] ?? false);
        const cleared = opening
          ? Object.fromEntries(Object.keys(prev.subsections).map((k) => [k, false]))
          : prev.subsections;
        const next = {
          ...prev,
          subsections: { ...cleared, [key]: opening },
        };
        saveSidebarState(next);
        return next;
      });
    },
    []
  );

  const toggleRightSection = useCallback(
    (key: "modelSectionOpen" | "reasoningEffortSectionOpen" | "tempSectionOpen" | "maxTokensSectionOpen" | "toolsSectionOpen" | "clientSectionOpen") => {
      setSidebarState((prev) => {
        const opening = !prev[key];
        const next = {
          ...prev,
          modelSectionOpen: false,
          reasoningEffortSectionOpen: false,
          tempSectionOpen: false,
          maxTokensSectionOpen: false,
          toolsSectionOpen: false,
          clientSectionOpen: false,
          [key]: opening,
        };
        saveSidebarState(next);
        return next;
      });
    },
    []
  );

  const [loadingModels, setLoadingModels] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string>("");
  const [modelMetaOpen, setModelMetaOpen] = useState(false);
  const [requestJsonOpen, setRequestJsonOpen] = useState(false);
  const [modelMetaLoading, setModelMetaLoading] = useState(false);
  const [modelMetaError, setModelMetaError] = useState("");
  const [modelMeta, setModelMeta] = useState<OllamaModelMeta | null>(null);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [stepDraft, setStepDraft] = useState("");
  const [inspectStep, setInspectStep] = useState<ConversationStep | null>(null);
  const [toolsCardExpanded, setToolsCardExpanded] = useState(false);
  const [stoppedConversationId, setStoppedConversationId] = useState<string | null>(null);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const previousSelectedConversationIdRef = useRef<string>("");
  const previousStepCountRef = useRef(0);
  const backendClientRef = useRef(new BackendClient());

  // ── Tour state ──────────────────────────────────────────────────────
  const [tourRun, setTourRun] = useState(false);
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const tourConversationIdsRef = useRef<string[]>([]);
  const preTourSidebarStateRef = useRef<SidebarState | null>(null);
  const tourInitRef = useRef(false);

  // Seed tour conversations and auto-start on first visit
  useEffect(() => {
    if (tourInitRef.current) return;
    tourInitRef.current = true;

    const completed = window.localStorage.getItem(TOUR_COMPLETED_KEY);
    if (completed === "true") return;

    // Defer tour on narrow viewports
    if (window.innerWidth < 768) return;

    // Wait for initial data to settle before starting tour
    const timer = setTimeout(() => {
      setConversations((current) => {
        // Don't seed if tour conversations already exist (e.g. resume after refresh)
        const existingTour = current.filter((c) => c._tourExample);
        if (existingTour.length > 0) {
          tourConversationIdsRef.current = existingTour.map((c) => c.id);
          return current;
        }

        const model = current[0]?.model ?? fallbackModels[0].name;
        const tourConvos = createTourConversations(model, tools);
        tourConversationIdsRef.current = tourConvos.map((c) => c.id);
        return [...tourConvos, ...current];
      });

      // Select first tour conversation
      setConversations((current) => {
        const firstTour = current.find((c) => c._tourExample);
        if (firstTour) {
          setSelectedConversationId(firstTour.id);
        }
        return current;
      });

      // Resume from saved step or start at 0
      const savedStep = window.localStorage.getItem(TOUR_STEP_KEY);
      const resumeIndex = savedStep ? parseInt(savedStep, 10) : 0;
      setTourStepIndex(isNaN(resumeIndex) ? 0 : resumeIndex);
      setTourRun(true);
    }, 500);

    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleStartTour() {
    if (window.innerWidth < 768) {
      alert("For the best experience, please use a screen at least 768px wide.");
      return;
    }

    // Save current sidebar state to restore after tour
    preTourSidebarStateRef.current = { ...sidebarState };

    window.localStorage.removeItem(TOUR_COMPLETED_KEY);

    // Seed tour conversations if they don't already exist
    const model = selectedConversation?.model ?? availableModels[0]?.name ?? fallbackModels[0].name;
    setConversations((current) => {
      const existingTour = current.filter((c) => c._tourExample);
      if (existingTour.length > 0) {
        tourConversationIdsRef.current = existingTour.map((c) => c.id);
        const firstTour = existingTour[0];
        setSelectedConversationId(firstTour.id);
        return current;
      }

      const tourConvos = createTourConversations(model, tools);
      tourConversationIdsRef.current = tourConvos.map((c) => c.id);
      setSelectedConversationId(tourConvos[0].id);
      return [...tourConvos, ...current];
    });

    // Ensure left sidebar is open for the first steps
    updateSidebar({ sidebarOpen: true });

    window.localStorage.removeItem(TOUR_STEP_KEY);
    setTourStepIndex(0);
    setTourRun(true);
  }

  function finishTour() {
    // Stop the tour and dismiss backdrop immediately
    setTourRun(false);
    setTourStepIndex(0);
    window.localStorage.setItem(TOUR_COMPLETED_KEY, "true");
    window.localStorage.removeItem(TOUR_STEP_KEY);

    // Remove all tour conversations (identified by _tourExample flag)
    setConversations((current) => {
      const remaining = current.filter((c) => !c._tourExample);

      // Select first remaining conversation (preserves user's original chats)
      setSelectedConversationId((currentId) => {
        if (remaining.some((c) => c.id === currentId)) return currentId;
        return remaining[0]?.id ?? "";
      });

      return remaining;
    });

    tourConversationIdsRef.current = [];

    // Collapse both sidebars after tour
    if (preTourSidebarStateRef.current) {
      const restored = {
        ...preTourSidebarStateRef.current,
        sidebarOpen: false,
        rightSidebarOpen: false,
      };
      setSidebarState(restored);
      saveSidebarState(restored);
      preTourSidebarStateRef.current = null;
    } else {
      updateSidebar({ sidebarOpen: false, rightSidebarOpen: false });
    }
  }

  function applyTourStepSideEffects(nextIndex: number) {
    // Indices 7-10: ensure right sidebar is open for all right sidebar steps
    if (nextIndex >= 7 && nextIndex <= 10) {
      const rightPatch: Partial<SidebarState> = { rightSidebarOpen: true };

      if (nextIndex === 7) {
        // Index 7 (Models): expand Models + open all provider subsections
        // Use ref to avoid stale closure in memoized callback
        const currentModels = modelsRef.current.filter((m) => !isEmbeddingModel(m));
        const providerKeys: Record<string, boolean> = {};
        for (const m of currentModels.length > 0 ? currentModels : fallbackModels) {
          providerKeys[`model-${m.providerName ?? "Local"}`] = true;
        }
        setSidebarState((prev) => {
          const next = {
            ...prev,
            ...rightPatch,
            modelSectionOpen: true,
            tempSectionOpen: false,
            maxTokensSectionOpen: false,
            toolsSectionOpen: false,
            subsections: { ...prev.subsections, ...providerKeys },
          };
          saveSidebarState(next);
          return next;
        });
      } else if (nextIndex === 8) {
        // Index 8 (Temperature): collapse Models, expand Temperature
        updateSidebar({ ...rightPatch, modelSectionOpen: false, tempSectionOpen: true, maxTokensSectionOpen: false, toolsSectionOpen: false });
      } else if (nextIndex === 9) {
        // Index 9 (Max Output Tokens): collapse Temperature, expand Max Tokens
        updateSidebar({ ...rightPatch, modelSectionOpen: false, tempSectionOpen: false, maxTokensSectionOpen: true, toolsSectionOpen: false });
      } else if (nextIndex === 10) {
        // Index 10 (Tools): collapse Max Tokens, expand Tools + open builtin subsection + check web_search
        setSidebarState((prev) => {
          const next = {
            ...prev,
            ...rightPatch,
            modelSectionOpen: false,
            tempSectionOpen: false,
            maxTokensSectionOpen: false,
            toolsSectionOpen: true,
            subsections: { ...prev.subsections, "tools-builtin": true },
          };
          saveSidebarState(next);
          return next;
        });
        // Enable web_search tool after a brief delay so the user sees it toggle
        setTimeout(() => {
          const webSearchTool = tools.find((t) => t.name === "web_search");
          if (webSearchTool && selectedConversation && !selectedConversation.activeToolIds.includes(webSearchTool.id)) {
            updateConversation(selectedConversation.id, (c) => ({
              ...c,
              activeToolIds: [...c.activeToolIds, webSearchTool.id],
              updatedAt: new Date().toISOString(),
            }));
          }
        }, 800);
      }
    }

  }

  // Steps that trigger sidebar/section animations and need a delay before advancing
  const STEPS_NEEDING_DELAY = new Set([7]);

  const advanceToStep = useCallback((nextIndex: number) => {
    setTourStepIndex(nextIndex);
    window.localStorage.setItem(TOUR_STEP_KEY, String(nextIndex));
  }, []);

  const handleJoyrideEvent = useCallback(
    (data: EventData) => {
      const { action, index, status, type } = data;

      if (
        status === STATUS.FINISHED ||
        status === STATUS.SKIPPED ||
        action === ACTIONS.CLOSE
      ) {
        finishTour();
        return;
      }

      // Skip past steps whose target element doesn't exist in the DOM
      if (type === EVENTS.TARGET_NOT_FOUND) {
        const nextIndex = index + 1;
        if (nextIndex < tourSteps.length) {
          advanceToStep(nextIndex);
        }
        return;
      }

      if (type === EVENTS.STEP_AFTER) {
        const nextIndex =
          action === ACTIONS.PREV ? index - 1 : index + 1;

        // Past the last step — tour is done
        if (nextIndex >= tourSteps.length) {
          finishTour();
          return;
        }

        if (nextIndex >= 0) {
          applyTourStepSideEffects(nextIndex);

          // Only delay for steps that trigger sidebar/section animations (350ms transition)
          if (STEPS_NEEDING_DELAY.has(nextIndex)) {
            setTimeout(() => advanceToStep(nextIndex), 400);
          } else {
            advanceToStep(nextIndex);
          }
        }
      }
    },
    [advanceToStep] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleWsMessage = useCallback(
    (data: unknown) => {
      const msg = data as { type?: string; tools?: ToolDefinition[] };
      if (msg.type === "tools.update" && msg.tools) {
        setTools((current) => {
          const merged = [...current];
          for (const tool of msg.tools!) {
            if (!merged.some((t) => t.id === tool.id)) {
              merged.push(tool);
            }
          }
          return merged;
        });
        return;
      }
      backendClientRef.current.handleServerMessage(data);
    },
    []
  );

  const { send: wsSend, connected: wsConnected } = useWebSocket(WS_URL, handleWsMessage, () => backendClientRef.current.cancelPendingTokenize());

  useEffect(() => {
    const initialConversations = loadConversations([]);
    const selectedId = loadSelectedConversationId() ?? initialConversations[0]?.id ?? "";

    setConversations(initialConversations);
    setConversationOrder(loadConversationOrder());
    setSelectedConversationId(selectedId);
  }, []);

  // Fetch available tools from the backend
  useEffect(() => {
    let cancelled = false;
    async function loadTools() {
      try {
        const remoteTools = await fetchTools();
        if (!cancelled) {
          setTools(remoteTools);
        }
      } catch {
        // Backend unreachable — no tools available
      }
    }
    void loadTools();
    return () => { cancelled = true; };
  }, []);

  // Re-sync existing conversations when the tool list changes
  useEffect(() => {
    if (tools.length === 0) return;
    setConversations((current) =>
      current.map((conv) => ensureConversationTools(conv, tools))
    );
  }, [tools]);

  const availableModels = useMemo(() => {
    const filteredModels = models.filter((model) => !isEmbeddingModel(model));
    return filteredModels.length > 0 ? filteredModels : fallbackModels;
  }, [models]);

  useEffect(() => {
    if (conversations.length === 0) {
      return;
    }

    saveConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    if (selectedConversationId) {
      saveSelectedConversationId(selectedConversationId);
    }
  }, [selectedConversationId]);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      try {
        const models = await fetchAllModels();
        if (!cancelled && models.length > 0) {
          setModels(models);
        }
      } catch {
        if (!cancelled) {
          setError("Could not reach the backend. Using fallback model list.");
        }
      } finally {
        if (!cancelled) {
          setLoadingModels(false);
        }
      }
    }

    void loadModels();

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId]
  );
  // Real computed-boundary provider for TokenViewStepContent (story S3),
  // fulfilling the contract S2 mocked. All separator/whitespace/boundary
  // logic itself still lives in src/lib/token-view.ts (AC-STRUCT-3) — this
  // is just wiring backend-client.tokenize() to the current model.
  const tokenizeStepText = useCallback(
    (text: string) => {
      const model = selectedConversation?.model;
      if (!model) return Promise.reject(new Error("no active model"));
      // Explicit provider (S3-F4) avoids the router's model-name-only modelProviderMap fallback.
      return backendClientRef.current.tokenize(wsSend, model, text, selectedConversation?.provider).then((r) => r.tokens);
    },
    [selectedConversation?.model, selectedConversation?.provider, wsSend]
  );
  useEffect(() => {
    setNoteDraft(selectedConversation?.note ?? "");
    setEditingNoteId(null);
  }, [selectedConversationId]);

  const activeTools = useMemo(
    () =>
      selectedConversation?.availableTools.filter((tool) =>
        selectedConversation.activeToolIds.includes(tool.id)
      ) ?? [],
    [selectedConversation]
  );
  const toolSearchLower = toolSearch.toLowerCase();
  const hasToolFilter = toolFilterActive || Boolean(toolSearchLower);
  const activeToolIds = selectedConversation?.activeToolIds ?? [];
  const matchesToolFilter = useCallback(
    (t: ToolDefinition) => {
      if (toolSearchLower && !t.name.toLowerCase().includes(toolSearchLower)) return false;
      if (toolFilterActive && !activeToolIds.includes(t.id)) return false;
      return true;
    },
    [toolSearchLower, toolFilterActive, activeToolIds]
  );
  const builtinTools = useMemo(
    () => (selectedConversation?.availableTools ?? [])
      .filter((t) => !t.id.startsWith("mcp-"))
      .filter(matchesToolFilter),
    [selectedConversation, matchesToolFilter]
  );
  const mcpServers = useMemo(() => {
    const servers = new Map<string, ToolDefinition[]>();
    for (const tool of selectedConversation?.availableTools ?? []) {
      const match = tool.id.match(/^mcp-(.+?)-/);
      if (!match) continue;
      if (!matchesToolFilter(tool)) continue;
      const serverName = match[1];
      const group = servers.get(serverName) ?? [];
      group.push(tool);
      servers.set(serverName, group);
    }
    return servers;
  }, [selectedConversation, toolSearchLower]);
  const visibleTranscriptSteps = useMemo(
    () => selectedConversation?.steps.filter(isVisibleTranscriptStep) ?? [],
    [selectedConversation]
  );
  const lastDeletableStepId = useMemo(() => {
    if (!selectedConversation || streaming) return null;
    const steps = selectedConversation.steps;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].kind === "user" || steps[i].kind === "assistant") {
        return steps[i].id;
      }
    }
    return null;
  }, [selectedConversation, streaming]);
  const requestJsonPreview = useMemo(() => {
    if (!selectedConversation) {
      return "";
    }

    const previewModel = availableModels.find(
      (m) =>
        m.name === selectedConversation.model &&
        m.provider === selectedConversation.provider
    );
    const previewReasoningSupported = previewModel
      ? isReasoningModel(previewModel)
      : false;

    return JSON.stringify(
      buildOpenAIRequestBody({
        model: selectedConversation.model,
        steps: selectedConversation.steps,
        tools: activeTools,
        temperature: selectedConversation.temperature,
        maxOutputTokens: selectedConversation.maxOutputTokens,
        reasoningEffort: previewReasoningSupported
          ? selectedConversation.reasoningEffort
          : undefined,
      }),
      null,
      2
    );
  }, [activeTools, availableModels, composerValue, selectedConversation]);

  useEffect(() => {
    if (!selectedConversation && conversations.length > 0) {
      setSelectedConversationId(conversations[0].id);
    }
  }, [conversations, selectedConversation]);

  useEffect(() => {
    setEditingStepId(null);
    setStepDraft("");
  }, [selectedConversationId]);

  useEffect(() => {
    const currentConversationId = selectedConversation?.id ?? "";
    const stepCount = selectedConversation?.steps.length ?? 0;
    const conversationChanged =
      previousSelectedConversationIdRef.current !== currentConversationId;
    const newStepAdded = stepCount > previousStepCountRef.current;

    if (conversationChanged || newStepAdded) {
      transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }

    previousSelectedConversationIdRef.current = currentConversationId;
    previousStepCountRef.current = stepCount;
  }, [selectedConversationId, selectedConversation?.steps.length]);

  useEffect(() => {
    if (!selectedConversation || availableModels.length === 0) {
      return;
    }

    // Try to find an exact (provider, model) match first, then fall back to name-only
    const exactMatch = availableModels.find(
      (m) =>
        m.name === selectedConversation.model &&
        m.provider === selectedConversation.provider
    );
    const nameMatch = availableModels.find(
      (m) => m.name === selectedConversation.model
    );
    const match = exactMatch ?? nameMatch;

    if (!match) {
      // Model not found at all — reset to first available
      updateConversation(selectedConversation.id, (conversation) => ({
        ...conversation,
        model: availableModels[0].name,
        provider: availableModels[0].provider,
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    // Repair missing or stale provider on migrated conversations
    if (selectedConversation.provider !== match.provider) {
      updateConversation(selectedConversation.id, (conversation) => ({
        ...conversation,
        provider: match.provider,
        updatedAt: new Date().toISOString(),
      }));
    }
  }, [availableModels, selectedConversation]);

  function updateConversation(
    id: string,
    updater: (conversation: Conversation) => Conversation
  ) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === id ? updater(conversation) : conversation
      )
    );
  }

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const visibleConversations = useMemo(() => {
    const filtered = conversations.filter((c) => c.steps.some((s) => s.kind === "user"));
    if (!conversationOrder) return filtered;
    const byId = new Map(filtered.map((c) => [c.id, c]));
    const ordered: Conversation[] = [];
    for (const id of conversationOrder) {
      const c = byId.get(id);
      if (c) {
        ordered.push(c);
        byId.delete(id);
      }
    }
    // Append any conversations not in the saved order (new ones) at the top
    for (const c of filtered) {
      if (byId.has(c.id)) ordered.unshift(c);
    }
    return ordered;
  }, [conversations, conversationOrder]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = visibleConversations.findIndex((c) => c.id === active.id);
    const newIndex = visibleConversations.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(visibleConversations, oldIndex, newIndex);
    const newOrder = reordered.map((c) => c.id);
    setConversationOrder(newOrder);
    saveConversationOrder(newOrder);
  }

  function handleCreateConversation() {
    const firstModel = availableModels[0];
    const model = firstModel?.name ?? fallbackModels[0].name;
    const conversation = createConversation(model, tools, firstModel?.provider);
    setConversations((current) => [conversation, ...current]);
    setSelectedConversationId(conversation.id);
    setComposerValue("");
  }

  function handleDeleteConversation(id: string) {
    setConversations((current) => {
      const remaining = current.filter((conversation) => conversation.id !== id);

      setSelectedConversationId((currentSelectedId) => {
        if (currentSelectedId !== id) {
          return currentSelectedId;
        }

        return remaining[0]?.id ?? "";
      });

      if (editingConversationId === id) {
        handleCancelTitleEdit();
      }

      if (selectedConversationId === id) {
        handleCancelStepEdit();
      }

      return remaining;
    });

    setConversationOrder((current) => {
      if (!current) return current;
      const updated = current.filter((cid) => cid !== id);
      saveConversationOrder(updated);
      return updated;
    });
  }

  function handleModelChange(compositeKey: string) {
    if (!selectedConversation) {
      return;
    }

    const { provider, model } = parseModelSelectKey(compositeKey);
    updateConversation(selectedConversation.id, (conversation) => ({
      ...conversation,
      model,
      provider,
      updatedAt: new Date().toISOString(),
    }));
  }

  function handleTemperatureChange(value: number | undefined) {
    if (!selectedConversation) {
      return;
    }

    updateConversation(selectedConversation.id, (conversation) => ({
      ...conversation,
      temperature: value,
      updatedAt: new Date().toISOString(),
    }));
  }

  function handleMaxOutputTokensChange(value: number | undefined) {
    if (!selectedConversation) {
      return;
    }

    updateConversation(selectedConversation.id, (conversation) => ({
      ...conversation,
      maxOutputTokens: value,
      updatedAt: new Date().toISOString(),
    }));
  }

  function handleReasoningEffortChange(value: ReasoningEffort | undefined) {
    if (!selectedConversation) {
      return;
    }

    updateConversation(selectedConversation.id, (conversation) => ({
      ...conversation,
      reasoningEffort: value,
      updatedAt: new Date().toISOString(),
    }));
  }

  async function handleOpenModelMeta() {
    if (!selectedConversation) {
      return;
    }

    const model = availableModels.find(
      (entry) =>
        entry.name === selectedConversation.model &&
        entry.provider === selectedConversation.provider
    );
    if (!model) {
      return;
    }

    setModelMetaOpen(true);
    setModelMetaLoading(true);
    setModelMetaError("");
    setModelMeta(null);

    try {
      const nextMeta = await fetchModelMeta(model);
      setModelMeta(nextMeta);
    } catch (err) {
      setModelMetaError(
        err instanceof Error ? err.message : "Failed to load model metadata."
      );
    } finally {
      setModelMetaLoading(false);
    }
  }

  function handleStartTitleEdit(conversation: Conversation) {
    setEditingConversationId(conversation.id);
    setTitleDraft(conversation.title);
  }

  function handleCancelTitleEdit() {
    setEditingConversationId(null);
    setTitleDraft("");
  }

  function handleSaveNote(id: string) {
    const note = noteDraft;
    updateConversation(id, (conversation) => ({
      ...conversation,
      note,
    }));
    setEditingNoteId(null);
  }

  function handleStartNoteEdit(conversation: Conversation) {
    setEditingNoteId(conversation.id);
    setNoteDraft(conversation.note ?? "");
  }

  function handleStartStepEdit(step: ConversationStep) {
    if (!selectedConversation || step.kind !== "user" || streaming) {
      return;
    }

    updateConversation(selectedConversation.id, (conversation) => ({
      ...conversation,
      steps: conversation.steps.map((conversationStep) =>
        conversationStep.id === step.id
          ? { ...conversationStep, expanded: true }
          : conversationStep
      ),
    }));
    setEditingStepId(step.id);
    setStepDraft(step.content);
  }

  function handleCancelStepEdit() {
    setEditingStepId(null);
    setStepDraft("");
  }

  function handleSaveTitle(id: string) {
    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      handleCancelTitleEdit();
      return;
    }

    updateConversation(id, (conversation) => ({
      ...conversation,
      title: nextTitle,
      titleEdited: true,
      updatedAt: new Date().toISOString(),
    }));
    handleCancelTitleEdit();
  }

  function applyDelta(conversationId: string, partialSteps: ConversationStep[]) {
    updateConversation(conversationId, (conversation) => {
      const stableSteps = conversation.steps.filter(
        (step) =>
          !step.id.startsWith("stream-") &&
          (step.kind === "system" ||
            step.kind === "user" ||
            step.kind === "assistant" ||
            step.kind === "reasoning" ||
            step.kind === "tool_call" ||
            step.kind === "tool_result" ||
            step.kind === "meta")
      );

      const nextStreamingSteps = partialSteps.map((step) => ({
        ...step,
        id: `stream-${step.id}`,
        expanded: defaultExpanded(step),
      }));

      return {
        ...conversation,
        steps: [...stableSteps, ...nextStreamingSteps],
        updatedAt: new Date().toISOString(),
      };
    });
  }

  function applyStableSteps(conversationId: string, newSteps: ConversationStep[]) {
    updateConversation(conversationId, (conversation) => {
      // Remove streaming steps, then upsert new stable steps by ID
      const stableSteps = conversation.steps.filter((s) => !s.id.startsWith("stream-"));
      const newStepIds = new Set(newSteps.map((s) => s.id));
      const existing = stableSteps.filter((s) => !newStepIds.has(s.id));
      return {
        ...conversation,
        steps: [...existing, ...newSteps.map((s) => ({ ...s, expanded: defaultExpanded(s) }))],
        updatedAt: new Date().toISOString(),
      };
    });
  }

  function applyMetaEvent(conversationId: string, metaStep: ConversationStep) {
    updateConversation(conversationId, (conversation) => {
      // Insert meta step before streaming steps so it appears above the current stream
      const streamingIdx = conversation.steps.findIndex((s) => s.id.startsWith("stream-"));
      const insertIdx = streamingIdx === -1 ? conversation.steps.length : streamingIdx;
      const nextSteps = [...conversation.steps];
      nextSteps.splice(insertIdx, 0, { ...metaStep, expanded: defaultExpanded(metaStep) });
      return {
        ...conversation,
        steps: nextSteps,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function streamConversationResponse(
    nextConversation: Conversation,
    options?: { prompt?: string }
  ) {
    setError("");
    setStreaming(true);
    setStoppedConversationId(null);

    const activeTools = nextConversation.availableTools.filter((tool) =>
      nextConversation.activeToolIds.includes(tool.id)
    );

    // Build the steps to send — include prompt as a user step if provided
    const stepsToSend = options?.prompt
      ? [
          ...nextConversation.steps,
          {
            id: `prompt-${Date.now()}`,
            kind: "user" as const,
            title: "User",
            content: options.prompt,
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ]
      : nextConversation.steps;

    if (!wsConnected) {
      setError("Backend is not connected. Make sure the server is running (make dev).");
      setStreaming(false);
      return;
    }

    const streamModel = availableModels.find(
      (m) =>
        m.name === nextConversation.model &&
        m.provider === nextConversation.provider
    );
    const streamReasoningSupported = streamModel ? isReasoningModel(streamModel) : false;

    const { promise, stop } = backendClientRef.current.startStream(wsSend, {
      conversationId: nextConversation.id,
      model: nextConversation.model,
      provider: nextConversation.provider,
      steps: stepsToSend,
      tools: activeTools,
      temperature: nextConversation.temperature,
      maxOutputTokens: nextConversation.maxOutputTokens,
      reasoningEffort: streamReasoningSupported ? nextConversation.reasoningEffort : undefined,
      onDelta: (partialSteps) => applyDelta(nextConversation.id, partialSteps),
      onStableSteps: (stableSteps) => applyStableSteps(nextConversation.id, stableSteps),
      onMetaEvent: (metaStep) => applyMetaEvent(nextConversation.id, metaStep),
    });
    stopStreamRef.current = stop;

    try {
      const responseSteps = await promise;
      updateConversation(nextConversation.id, (conversation) => {
        const stableSteps = conversation.steps.filter((step) => !step.id.startsWith("stream-"));
        const existingIds = new Set(stableSteps.map((s) => s.id));
        const newSteps = responseSteps
          .filter((s) => !existingIds.has(s.id))
          .map((s) => ({ ...s, expanded: defaultExpanded(s) }));
        return {
          ...conversation,
          steps: [...stableSteps, ...newSteps],
          updatedAt: new Date().toISOString(),
        };
      });
    } catch (streamError) {
      const isAbort =
        streamError instanceof Error && streamError.message === "AbortError";
      const message = isAbort
        ? "Generation stopped."
        : "Failed to stream from backend.";
      setError(message);
      updateConversation(nextConversation.id, (conversation) => {
        const cleanedSteps = conversation.steps.filter((step) => !step.id.startsWith("stream-"));
        return {
          ...conversation,
          steps: cleanedSteps,
          updatedAt: new Date().toISOString(),
        };
      });
      if (isAbort) {
        setStoppedConversationId(nextConversation.id);
      }
    } finally {
      stopStreamRef.current = null;
      setStreaming(false);
    }
  }

  async function handleSaveStepEdit(stepId: string) {
    if (!selectedConversation) {
      return;
    }

    const nextContent = stepDraft.trim();
    if (!nextContent) {
      handleCancelStepEdit();
      return;
    }

    const stepIndex = selectedConversation.steps.findIndex((step) => step.id === stepId);
    if (stepIndex === -1) {
      return;
    }

    const targetStep = selectedConversation.steps[stepIndex];
    if (targetStep.kind !== "user") {
      return;
    }

    const nextSteps = [
      ...selectedConversation.steps.slice(0, stepIndex),
      {
        ...targetStep,
        content: nextContent,
        expanded: true,
      },
    ];

    const nextConversation = {
      ...selectedConversation,
      title: selectedConversation.titleEdited
        ? selectedConversation.title
        : inferTitle(nextSteps),
      steps: nextSteps,
      updatedAt: new Date().toISOString(),
    };

    updateConversation(selectedConversation.id, () => nextConversation);

    handleCancelStepEdit();
    await streamConversationResponse(nextConversation);
  }

  function handleDeleteLastExchange() {
    if (!selectedConversation || streaming) {
      return;
    }

    const steps = selectedConversation.steps;
    // Find the last user or assistant visible step
    let lastDeletableIndex = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].kind === "user" || steps[i].kind === "assistant") {
        lastDeletableIndex = i;
        break;
      }
    }
    if (lastDeletableIndex === -1) {
      return;
    }

    const lastDeletable = steps[lastDeletableIndex];
    let cutIndex: number;

    if (lastDeletable.kind === "user") {
      // No assistant response yet — just remove this user message
      cutIndex = lastDeletableIndex;
    } else {
      // Assistant message — remove all response steps after the last user message
      // but keep the user message itself
      cutIndex = lastDeletableIndex;
      for (let i = lastDeletableIndex - 1; i >= 0; i--) {
        if (steps[i].kind === "user") {
          cutIndex = i + 1;
          break;
        }
        if (steps[i].kind === "system") {
          break;
        }
      }
    }

    updateConversation(selectedConversation.id, (conv) => ({
      ...conv,
      steps: conv.steps.slice(0, cutIndex),
      updatedAt: new Date().toISOString(),
    }));
  }

  async function handleResendUserStep(stepId: string) {
    if (!selectedConversation || streaming) {
      return;
    }

    const stepIndex = selectedConversation.steps.findIndex((step) => step.id === stepId);
    if (stepIndex === -1) {
      return;
    }

    const targetStep = selectedConversation.steps[stepIndex];
    if (targetStep.kind !== "user") {
      return;
    }

    const nextConversation = {
      ...selectedConversation,
      steps: selectedConversation.steps.slice(0, stepIndex + 1),
      updatedAt: new Date().toISOString(),
    };

    updateConversation(selectedConversation.id, () => nextConversation);
    await streamConversationResponse(nextConversation);
  }

  async function handleRegenerateAssistantStep(stepId: string) {
    if (!selectedConversation || streaming) {
      return;
    }

    const stepIndex = selectedConversation.steps.findIndex((step) => step.id === stepId);
    if (stepIndex === -1) {
      return;
    }

    const targetStep = selectedConversation.steps[stepIndex];
    if (targetStep.kind !== "assistant") {
      return;
    }

    const responseStartIndex = findResponseStartIndex(selectedConversation.steps, stepIndex);
    const nextConversation = {
      ...selectedConversation,
      steps: selectedConversation.steps.slice(0, responseStartIndex),
      updatedAt: new Date().toISOString(),
    };

    updateConversation(selectedConversation.id, () => nextConversation);
    await streamConversationResponse(nextConversation);
  }

  function handlePromptChange(value: string) {
    if (!selectedConversation) {
      return;
    }

    updateConversation(selectedConversation.id, (conversation) => {
      const nextSteps = conversation.steps.map((step, index) =>
        index === 0 && step.kind === "system" ? { ...step, content: value } : step
      );

      return {
        ...conversation,
        systemPrompt: value,
        steps: nextSteps,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  function handleToggleStep(stepId: string) {
    if (!selectedConversation) {
      return;
    }

    updateConversation(selectedConversation.id, (conversation) => ({
      ...conversation,
      steps: conversation.steps.map((step) =>
        step.id === stepId ? { ...step, expanded: !step.expanded } : step
      ),
    }));
  }

  function handleToggleConversationTool(toolId: string) {
    if (!selectedConversation) {
      return;
    }

    updateConversation(selectedConversation.id, (conversation) => ({
      ...conversation,
      activeToolIds: conversation.activeToolIds.includes(toolId)
        ? conversation.activeToolIds.filter((id) => id !== toolId)
        : [...conversation.activeToolIds, toolId],
      updatedAt: new Date().toISOString(),
    }));
  }

  async function handleSendPrompt() {
    if (!selectedConversation || !composerValue.trim() || streaming) {
      return;
    }

    const prompt = composerValue.trim();
    setComposerValue("");

    const userStep = createStep("user", "User", prompt);
    const nextConversation = {
      ...selectedConversation,
      title: selectedConversation.titleEdited
        ? selectedConversation.title
        : inferTitle([...selectedConversation.steps, userStep]),
      steps: [...selectedConversation.steps, userStep],
      updatedAt: new Date().toISOString(),
    };

    updateConversation(selectedConversation.id, () => nextConversation);

    await streamConversationResponse(nextConversation);
  }

  function handleStop() {
    stopStreamRef.current?.();
  }

  async function handleResume() {
    if (!selectedConversation || streaming) return;
    setStoppedConversationId(null);
    await streamConversationResponse(selectedConversation);
  }

  function navigateToTool(toolId: string) {
    // Determine which subsection this tool belongs to
    const mcpMatch = toolId.match(/^mcp-(.+?)-/);
    const subsectionKey = mcpMatch ? `tools-mcp-${mcpMatch[1]}` : "tools-builtin";

    // Open right sidebar, expand tools section and the correct subsection
    setSidebarState((prev) => {
      const next = {
        ...prev,
        rightSidebarOpen: true,
        toolsSectionOpen: true,
        subsections: { ...prev.subsections, [subsectionKey]: true },
      };
      saveSidebarState(next);
      return next;
    });

    // Scroll to the tool after the sidebar animations settle
    requestAnimationFrame(() => {
      setTimeout(() => {
        const el = document.querySelector(`[data-tool-id="${toolId}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 350);
    });
  }


  const selectedModel = selectedConversation
    ? modelSelectKey(selectedConversation.provider, selectedConversation.model)
    : modelSelectKey(availableModels[0]?.provider, availableModels[0]?.name ?? "");
  const selectedTemperature = selectedConversation?.temperature;
  const selectedModelObject = selectedConversation
    ? availableModels.find(
        (m) =>
          m.name === selectedConversation.model &&
          m.provider === selectedConversation.provider
      )
    : undefined;
  const temperatureSupported = supportsTemperature(selectedModelObject);
  const reasoningEffortSupported = selectedModelObject
    ? isReasoningModel(selectedModelObject)
    : false;
  const selectedReasoningEffort = selectedConversation?.reasoningEffort;

  const canResume = !streaming
    && stoppedConversationId != null
    && selectedConversation != null
    && stoppedConversationId === selectedConversation.id
    && (() => {
      const lastStep = selectedConversation.steps[selectedConversation.steps.length - 1];
      return lastStep != null && lastStep.kind !== "assistant";
    })();

  const composerLabel = "User Prompt";
  const composerPlaceholder = "";
  const canEditSystemPrompt = selectedConversation != null;

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100dvh",
        overflow: "hidden",
        overscrollBehavior: "none",
        color: "text.primary",
      }}
    >
      <Joyride
        steps={tourSteps}
        run={tourRun}
        stepIndex={tourStepIndex}
        continuous
        scrollToFirstStep
        onEvent={handleJoyrideEvent}
        locale={{
          back: "Back",
          close: "Close",
          last: "Finish",
          next: "Next",
          skip: "Skip tour",
        }}
        options={{
          showProgress: true,
          overlayClickAction: false,
          primaryColor: "#2457d6",
          textColor: "#333333",
          backgroundColor: "#ffffff",
          zIndex: 10000,
          buttons: ["back", "close", "primary", "skip"],
        }}
        styles={{
          tooltip: {
            borderRadius: 18,
            fontFamily: "'IBM Plex Sans', 'Segoe UI', sans-serif",
          },
        }}
      />
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
          {selectedConversation ? (
            <>
              <Chip
                data-tour="model-chip"
                icon={<MemoryOutlinedIcon />}
                label={selectedConversation.model}
                color="primary"
                clickable
                onClick={() => {
                  const match = availableModels.find(
                    (m) =>
                      m.name === selectedConversation.model &&
                      m.provider === selectedConversation.provider
                  );
                  const subsectionKey = `model-${match?.providerName ?? "Local"}`;
                  setSidebarState((prev) => {
                    const next = {
                      ...prev,
                      rightSidebarOpen: true,
                      modelSectionOpen: true,
                      reasoningEffortSectionOpen: false,
                      tempSectionOpen: false,
                      maxTokensSectionOpen: false,
                      toolsSectionOpen: false,
                      clientSectionOpen: false,
                      subsections: { ...prev.subsections, [subsectionKey]: true },
                    };
                    saveSidebarState(next);
                    return next;
                  });
                }}
                aria-label={`Open model settings for ${selectedConversation.model}`}
                size="small"
              />
              {selectedTemperature != null ? (
                <Chip
                  icon={<ThermostatOutlinedIcon />}
                  label={selectedTemperature.toFixed(1)}
                  color="primary"
                  clickable
                  onClick={() =>
                    updateSidebar({
                      rightSidebarOpen: true,
                      modelSectionOpen: false,
                      reasoningEffortSectionOpen: false,
                      tempSectionOpen: true,
                      maxTokensSectionOpen: false,
                      toolsSectionOpen: false,
                      clientSectionOpen: false,
                    })
                  }
                  aria-label="Open temperature settings"
                  size="small"
                />
              ) : null}
              {selectedConversation.maxOutputTokens != null ? (
                <Chip
                  icon={<TokenOutlinedIcon />}
                  label={selectedConversation.maxOutputTokens}
                  color="primary"
                  clickable
                  onClick={() =>
                    updateSidebar({
                      rightSidebarOpen: true,
                      modelSectionOpen: false,
                      reasoningEffortSectionOpen: false,
                      tempSectionOpen: false,
                      maxTokensSectionOpen: true,
                      toolsSectionOpen: false,
                      clientSectionOpen: false,
                    })
                  }
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
                  onClick={() =>
                    updateSidebar({
                      rightSidebarOpen: true,
                      modelSectionOpen: false,
                      reasoningEffortSectionOpen: true,
                      tempSectionOpen: false,
                      maxTokensSectionOpen: false,
                      toolsSectionOpen: false,
                      clientSectionOpen: false,
                    })
                  }
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

      <Box sx={{ display: "flex", flexGrow: 1, minHeight: `calc(100dvh - ${APP_BAR_HEIGHT}px)`, overflow: "hidden" }}>
        <Paper
          data-tour="sidebar"
          square
          onClick={sidebarOpen ? undefined : () => updateSidebar({ sidebarOpen: true })}
          sx={{
            width: sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH,
            minWidth: sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH,
            flexShrink: 0,
            position: "sticky",
            top: APP_BAR_HEIGHT,
            alignSelf: "flex-start",
            height: `calc(100dvh - ${APP_BAR_HEIGHT}px)`,
            borderRight: "1px solid",
            borderColor: "divider",
            backgroundColor: "var(--surface-sidebar)",
            overflow: "hidden",
            transition: "width 0.35s ease, min-width 0.35s ease",
            cursor: sidebarOpen ? "default" : "pointer",
          }}
        >
          <Box
            sx={{
              width: SIDEBAR_WIDTH,
              minWidth: SIDEBAR_WIDTH,
              height: "100%",
              py: 2,
              px: 1,
              display: "flex",
              flexDirection: "column",
              gap: 2,
              marginLeft: sidebarOpen ? 0 : `${-(SIDEBAR_WIDTH - SIDEBAR_COLLAPSED_WIDTH)}px`,
              transition: "margin-left 0.35s ease",
            }}
          >
            <Stack direction="row" alignItems="center">
              <Typography
                variant="overline"
                color="primary.light"
                sx={{
                  flexGrow: 1,
                  opacity: sidebarOpen ? 1 : 0,
                  transition: "opacity 0.25s ease",
                }}
              >
                Conversations
              </Typography>
              <IconButton
                data-tour="sidebar-toggle"
                size="small"
                onClick={() => updateSidebar({ sidebarOpen: !sidebarOpen })}
                aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
                sx={{ color: "text.secondary" }}
              >
                <ViewSidebarOutlinedIcon />
              </IconButton>
            </Stack>
            <Stack data-tour="new-chat" direction="row" alignItems="center">
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{
                  flexGrow: 1,
                  opacity: sidebarOpen ? 1 : 0,
                  transition: "opacity 0.25s ease",
                }}
              >
                New Chat
              </Typography>
              <IconButton
                size="small"
                onClick={handleCreateConversation}
                aria-label="New chat"
                sx={{ color: "text.secondary" }}
              >
                <EditOutlinedIcon fontSize="small" />
              </IconButton>
            </Stack>
            {showTour ? (
              <Stack data-tour="take-tour" direction="row" alignItems="center">
                <Typography
                  variant="overline"
                  color="text.secondary"
                  sx={{
                    flexGrow: 1,
                    opacity: sidebarOpen ? 1 : 0,
                    transition: "opacity 0.25s ease",
                  }}
                >
                  Take Tour
                </Typography>
                <IconButton
                  size="small"
                  onClick={handleStartTour}
                  aria-label="Take tour"
                  sx={{ color: "text.secondary" }}
                >
                  <TourOutlinedIcon fontSize="small" />
                </IconButton>
              </Stack>
            ) : null}
            <Box sx={{
              display: "flex",
              flexDirection: "column",
              gap: 0,
              flexGrow: 1,
              minHeight: 0,
              opacity: sidebarOpen ? 1 : 0,
              transition: "opacity 0.25s ease",
              pointerEvents: sidebarOpen ? "auto" : "none",
            }}>
              <List sx={{ p: 0, overflowY: "auto", flexGrow: 1, scrollbarGutter: "stable", pr: 1 }}>
            <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={visibleConversations.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            {visibleConversations.map((conversation, index) => (
              <SortableConversationCard
                key={conversation.id}
                conversation={conversation}
                index={index}
                isSelected={conversation.id === selectedConversationId}
                isEditingTitle={editingConversationId === conversation.id}
                isEditingNote={editingNoteId === conversation.id}
                titleDraft={titleDraft}
                noteDraft={noteDraft}
                onSelect={() => setSelectedConversationId(conversation.id)}
                onViewJson={(e) => { e.stopPropagation(); setRequestJsonOpen(true); }}
                onDelete={(e) => { e.stopPropagation(); setDeleteConfirmId(conversation.id); }}
                onTitleChange={(v) => setTitleDraft(v)}
                onTitleSave={() => handleSaveTitle(conversation.id)}
                onTitleCancel={handleCancelTitleEdit}
                onTitleEdit={() => handleStartTitleEdit(conversation)}
                onNoteChange={(v) => setNoteDraft(v)}
                onNoteSave={() => handleSaveNote(conversation.id)}
                onNoteEdit={() => handleStartNoteEdit(conversation)}
              />
            ))}
              </SortableContext>
            </DndContext>
          </List>
            </Box>
          </Box>
        </Paper>

        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            flexGrow: 1,
            minWidth: 0,
            minHeight: 0,
            py: 1,
            gap: 1,
            maxWidth: `calc(100vw - ${sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH}px - ${rightSidebarOpen ? RIGHT_SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH}px)`,
            transition: "max-width 0.35s ease",
          }}
        >
          {selectedConversation ? (
            <>
              <Box data-tour="transcript" sx={{
                flexGrow: 1,
                minHeight: 0,
                width: "100%",
                maxWidth: (sidebarOpen && rightSidebarOpen ? 900 : 700) + 48,
                transition: "max-width 0.35s ease",
                overflowY: "auto",
                px: 2,
                scrollbarGutter: "stable",
                maskImage: "linear-gradient(to bottom, transparent, black 2px, black calc(100% - 12px), transparent)",
                WebkitMaskImage: "linear-gradient(to bottom, transparent, black 2px, black calc(100% - 12px), transparent)",
              }}>
                <Stack spacing={2} sx={{ pt: 1, pb: 1, maxWidth: sidebarOpen && rightSidebarOpen ? 900 : 700, mx: "auto", transition: "max-width 0.35s ease" }}>
                  {error ? <Alert severity="warning">{error}</Alert> : null}

                  {!hideSystemPrompt && (
                  <TextField
                    data-tour="system-prompt"
                    label="System prompt"
                    InputLabelProps={{ shrink: true }}
                    multiline
                    minRows={2}
                    maxRows={12}
                    value={selectedConversation.systemPrompt}
                    onChange={(event) => handlePromptChange(event.target.value)}
                    disabled={!canEditSystemPrompt}
                    placeholder="No system prompt set."
                    sx={{ width: "100%" }}
                  />
                  )}

                  {!hideSystemPrompt && showExamples && !selectedConversation.steps.some((s) => s.kind === "user") ? (
                    <Stack data-testid="system-prompt-examples" spacing={1}>
                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        {SYSTEM_PROMPT_EXAMPLES.map((example) => (
                          <Chip
                            key={example.label}
                            label={example.label}
                            variant="outlined"
                            size="small"
                            onClick={() => handlePromptChange(example.prompt)}
                            data-testid={`example-${example.label.toLowerCase().replace(/\s+/g, "-")}`}
                          />
                        ))}
                      </Stack>
                    </Stack>
                  ) : null}

                    {activeTools.length > 0 ? (
                      <StepCard
                        step={{ id: "tools-card", kind: "system", title: "Tools", content: "", createdAt: selectedConversation.createdAt }}
                        expanded={toolsCardExpanded}
                        onToggle={() => setToolsCardExpanded((v) => !v)}
                        onInspect={() => {
                          const toolsJson = activeTools.map((t) => {
                            let parameters: unknown;
                            try { parameters = JSON.parse(t.inputSchema); } catch { parameters = t.inputSchema; }
                            return { type: "function", function: { name: t.name, description: t.description, parameters } };
                          });
                          setInspectStep({
                            id: "tools-card", kind: "system", title: "Tools",
                            content: JSON.stringify(toolsJson, null, 2),
                            createdAt: selectedConversation.createdAt,
                          });
                        }}
                        headerLabel={`tools (${activeTools.length})`}
                      >
                        <Stack spacing={1}>
                          {activeTools.map((tool) => (
                            <Box key={tool.id} onClick={() => navigateToTool(tool.id)} sx={{ cursor: "pointer", "&:hover": { opacity: 0.7 } }}>
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>{tool.name}</Typography>
                              <Typography variant="body2" color="text.secondary">{tool.description}</Typography>
                            </Box>
                          ))}
                        </Stack>
                      </StepCard>
                    ) : null}

                    {(() => {
                      const seenKinds = new Set<string>();
                      let cumulativeToolCalls = 0;
                      const items = visibleTranscriptSteps.map((step) => {
                        let dataTour: string | undefined;
                        if (!seenKinds.has(step.kind)) {
                          seenKinds.add(step.kind);
                          const tourMap: Record<string, string> = {
                            user: "step-user",
                            assistant: "step-assistant",
                            reasoning: "step-reasoning",
                            tool_call: "step-tool-call",
                            tool_result: "step-tool-result",
                            meta: "step-meta",
                          };
                          dataTour = tourMap[step.kind];
                        }
                        const hasToolCalls = step.toolCalls && step.toolCalls.length > 0;
                        if (hasToolCalls) {
                          cumulativeToolCalls += step.toolCalls!.length;
                        }
                        return {
                          key: step.id,
                          depth: hasToolCalls ? 1 : stepThreadDepth(step.kind),
                          element: (
                      <StepCard
                        key={step.id}
                        step={step}
                        dataTour={dataTour}
                        expanded={Boolean(step.expanded)}
                        onToggle={() => handleToggleStep(step.id)}
                        onInspect={step.kind !== "meta" && step.kind !== "reasoning" ? () => setInspectStep(step) : undefined}
                        headerLabel={hasToolCalls ? "tool call requests" : formatStepHeader(step)}
                        footerMeta={(() => {
                          const baseMeta = hasToolCalls
                            ? [step.model, `${step.toolCalls!.length} tool${step.toolCalls!.length !== 1 ? "s" : ""}`].filter(Boolean).join(" / ")
                            : formatStepFooterMeta(step);
                          if (step.kind === "assistant" && cumulativeToolCalls > 0) {
                            const suffix = `tool calls: ${cumulativeToolCalls}`;
                            return baseMeta ? `${baseMeta} / ${suffix}` : suffix;
                          }
                          return baseMeta;
                        })()}
                        bgColor={hasToolCalls ? getStepBackgroundColor("tool_call", theme) : undefined}
                        onDoubleClickContent={step.kind === "user" && !streaming && editingStepId !== step.id ? () => handleStartStepEdit(step) : undefined}
                        footerActions={
                          step.kind === "user" ? (
                            <>
                              <IconButton
                                size="small"
                                onClick={() => void navigator.clipboard.writeText(step.content)}
                                aria-label="Copy message"
                              >
                                <ContentCopyOutlinedIcon fontSize="small" />
                              </IconButton>
                              <IconButton
                                size="small"
                                onClick={() => handleStartStepEdit(step)}
                                disabled={streaming}
                                aria-label="Edit message"
                              >
                                <EditOutlinedIcon fontSize="small" />
                              </IconButton>
                              <IconButton
                                size="small"
                                onClick={() => void handleResendUserStep(step.id)}
                                disabled={streaming}
                                aria-label="Resend message"
                              >
                                <ReplayOutlinedIcon fontSize="small" />
                              </IconButton>
                              {step.id === lastDeletableStepId && (
                                <IconButton
                                  size="small"
                                  onClick={handleDeleteLastExchange}
                                  aria-label="Delete message"
                                >
                                  <DeleteOutlinedIcon fontSize="small" />
                                </IconButton>
                              )}
                            </>
                          ) : step.kind === "assistant" && !hasToolCalls ? (
                            <>
                              <IconButton
                                size="small"
                                onClick={() => void navigator.clipboard.writeText(step.content)}
                                aria-label="Copy message"
                              >
                                <ContentCopyOutlinedIcon fontSize="small" />
                              </IconButton>
                              <IconButton
                                size="small"
                                onClick={() => void handleRegenerateAssistantStep(step.id)}
                                disabled={streaming}
                                aria-label="Regenerate response"
                              >
                                <ReplayOutlinedIcon fontSize="small" />
                              </IconButton>
                              {step.id === lastDeletableStepId && (
                                <IconButton
                                  size="small"
                                  onClick={handleDeleteLastExchange}
                                  aria-label="Delete message"
                                >
                                  <DeleteOutlinedIcon fontSize="small" />
                                </IconButton>
                              )}
                            </>
                          ) : undefined
                        }
                      >
                        {step.metaEvent?.data ? (
                          <Typography variant="body2" sx={{ mb: 1, fontFamily: "monospace", whiteSpace: "pre-wrap", color: "text.secondary" }}>
                            {JSON.stringify(step.metaEvent.data, null, 2)}
                          </Typography>
                        ) : null}
                        {step.kind === "tool_result" && step.toolResult ? (
                          <Typography variant="body2" sx={{ mb: 1 }}>
                            {step.toolResult.name}
                          </Typography>
                        ) : null}
                        {hasToolCalls ? (
                          <Stack spacing={2}>
                            {step.toolCalls!.map((tc, i) => (
                              <Box key={tc.id ?? i}>
                                <Typography variant="body2" sx={{ mb: 0.5 }}>
                                  {tc.name}
                                </Typography>
                                <Typography variant="body2" sx={{ fontFamily: "monospace", whiteSpace: "pre-wrap", color: "text.secondary" }}>
                                  {JSON.stringify(tc.arguments, null, 2)}
                                </Typography>
                              </Box>
                            ))}
                          </Stack>
                        ) : editingStepId === step.id ? (
                          <Stack spacing={1.5}>
                            <TextField
                              label="Edit message"
                              multiline
                              minRows={3}
                              value={stepDraft}
                              onChange={(event) => setStepDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.shiftKey) {
                                  event.preventDefault();
                                  void handleSaveStepEdit(step.id);
                                }
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  handleCancelStepEdit();
                                }
                              }}
                              autoFocus
                            />
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Button variant="text" color="inherit" onClick={handleCancelStepEdit}>Abort</Button>
                              <Button variant="contained" onClick={() => void handleSaveStepEdit(step.id)}>Send</Button>
                            </Stack>
                          </Stack>
                        ) : (showTokens && (step.kind === "assistant" || step.kind === "user" || step.kind === "reasoning")) ? (
                          <TokenViewStepContent step={step} tokenizeText={tokenizeStepText} cacheKeySuffix={selectedConversation?.model} />
                        ) : ((step.kind === "assistant" || step.kind === "user" || step.kind === "reasoning") && renderMarkdown) ? (
                          <Box sx={{ lineHeight: 1.7, color: "text.primary", "& pre": { fontFamily: "monospace", whiteSpace: "pre-wrap", backgroundColor: "var(--surface-inset)", p: 1.5, borderRadius: 1, overflow: "auto" }, "& code": { fontFamily: "monospace", fontSize: "0.9em" }, "& p:first-of-type": { mt: 0 }, "& p:last-of-type": { mb: 0 }, "& table": { borderCollapse: "collapse", width: "100%", my: 1 }, "& th, & td": { border: "1px solid", borderColor: "divider", px: 1.5, py: 0.75, textAlign: "left" }, "& th": { backgroundColor: "var(--surface-inset)", fontWeight: 600 } }}>
                            <Markdown remarkPlugins={[remarkGfm]}>{step.content.replace(/^\n+|\n+$/g, "")}</Markdown>
                          </Box>
                        ) : (
                          <Typography variant="body1" sx={{ whiteSpace: "pre-wrap", lineHeight: 1.7, color: "text.primary", fontFamily: step.kind === "tool_result" ? "monospace" : undefined }}>
                            {(step.kind === "user" || step.kind === "assistant" || step.kind === "reasoning")
                              ? step.content.replace(/^\n+|\n+$/g, "")
                              : step.kind === "tool_result"
                                ? prettyPrintJson(step.content)
                                : (step.kind === "meta" && step.metaEvent?.kind === "search_result")
                                  ? ""
                                  : step.content}
                          </Typography>
                        )}
                      </StepCard>
                          ),
                        };
                      });
                      return wrapWithThreadBars(items, theme);
                    })()}
                    {streaming ? (
                      <Paper
                        sx={{
                          p: 3,
                          border: "1px solid",
                          borderColor: "divider",
                          backgroundColor: "var(--surface-card)",
                          filter: "blur(2px)",
                          opacity: 0.5,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          minHeight: 80,
                        }}
                      >
                        <CircularProgress size={24} />
                      </Paper>
                    ) : canResume ? (
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={<PlayArrowOutlinedIcon />}
                        onClick={() => void handleResume()}
                        aria-label="Resume generation"
                        sx={{ alignSelf: "center" }}
                      >
                        Resume
                      </Button>
                    ) : null}
                    <Box ref={transcriptEndRef} aria-hidden="true" />
                </Stack>
              </Box>

              <Box
                data-tour="composer"

                sx={{
                  flexShrink: 0,
                  width: "100%",
                  maxWidth: (sidebarOpen && rightSidebarOpen ? 900 : 700) + 48,
                  transition: "max-width 0.35s ease",
                  px: 2,
                  pt: 1,
                  pb: 2,
                  scrollbarGutter: "stable",
                }}
              >
                <Box sx={{
                  maxWidth: sidebarOpen && rightSidebarOpen ? 900 : 700,
                  mx: "auto",
                  transition: "max-width 0.35s ease",
                }}>

                <TextField
                  label={composerLabel}
                  InputLabelProps={{ shrink: true }}
                  multiline
                  minRows={3}
                  maxRows={12}
                  value={composerValue}
                  onChange={(event) => setComposerValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      if (composerValue.trim() && !streaming) {
                        void handleSendPrompt();
                      }
                    }
                  }}
                  placeholder={composerPlaceholder}
                  inputProps={{
                    style: {
                      overflowY: "auto",
                    },
                  }}
                  slotProps={{
                    input: {
                      endAdornment: streaming ? (
                        <InputAdornment position="end" sx={{ alignSelf: "flex-end", mb: 1 }}>
                          <IconButton
                            color="secondary"
                            onClick={handleStop}
                            aria-label="Stop"
                            size="small"
                          >
                            <StopOutlinedIcon fontSize="small" />
                          </IconButton>
                        </InputAdornment>
                      ) : undefined,
                    },
                  }}
                  fullWidth
                />
                </Box>
              </Box>
            </>
          ) : null}
        </Box>

        <Paper
          data-tour="right-sidebar"
          square
          onClick={rightSidebarOpen ? undefined : () => updateSidebar({ rightSidebarOpen: true })}
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
                onClick={() => updateSidebar({ rightSidebarOpen: !rightSidebarOpen })}
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

            {selectedConversation ? (
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
                  <Box data-tour="models-section">
                    <ListItemButton
                      onClick={() => toggleRightSection("modelSectionOpen")}
                      sx={{ mx: -2, px: 2, py: 0.5 }}
                    >
                      <Typography variant="overline" color="text.secondary" sx={{ flexGrow: 1 }}>
                        Models
                      </Typography>
                      {modelSectionOpen ? <ExpandLessOutlinedIcon fontSize="small" /> : <ExpandMoreOutlinedIcon fontSize="small" />}
                    </ListItemButton>
                    <Collapse in={modelSectionOpen}>
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
                        {(() => {
                          const modelSearchLower = modelSearch.toLowerCase();
                          const filtered = availableModels.filter((m) => {
                            if (modelSearchLower && !m.name.toLowerCase().includes(modelSearchLower)) return false;
                            if (modelFilterReasoning && !isReasoningModel(m)) return false;
                            if (modelFilterNonReasoning && isReasoningModel(m)) return false;
                            return true;
                          });
                          const providers = new Map<string, OllamaModel[]>();
                          for (const model of filtered) {
                            const key = model.providerName ?? "Local";
                            const group = providers.get(key) ?? [];
                            group.push(model);
                            providers.set(key, group);
                          }
                          const items: React.ReactNode[] = [];
                          for (const [providerName, group] of providers) {
                            const subsectionKey = `model-${providerName}`;
                            const hasModelFilter = modelFilterReasoning || modelFilterNonReasoning || Boolean(modelSearchLower);
                            const open = hasModelFilter || isSubsectionOpen(subsectionKey);
                            if (providers.size > 1) {
                              const hasSelectedModel = group.some(
                                (m) => modelSelectKey(m.provider, m.name) === selectedModel
                              );
                              items.push(
                                <ListItemButton
                                  key={`header-${providerName}`}
                                  onClick={() => toggleSubsection(subsectionKey)}
                                  selected={hasSelectedModel}
                                  sx={{ px: 1, py: 0.25, borderRadius: 1 }}
                                >
                                  <ListItemText
                                    primary={providerName}
                                    primaryTypographyProps={{ variant: "caption", color: hasSelectedModel ? "primary" : "text.secondary", fontWeight: 600 }}
                                  />
                                  <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
                                    {group.length}
                                  </Typography>
                                  {open ? <ExpandLessOutlinedIcon sx={{ fontSize: 14 }} /> : <ExpandMoreOutlinedIcon sx={{ fontSize: 14 }} />}
                                </ListItemButton>
                              );
                              items.push(
                                <Collapse key={`collapse-${providerName}`} in={open}>
                                  {group.map((model) => {
                                    const value = modelSelectKey(model.provider, model.name);
                                    const isSelected = value === selectedModel;
                                    return (
                                      <ListItemButton
                                        key={value}
                                        selected={isSelected}
                                        onClick={() => handleModelChange(value)}
                                        sx={{ borderRadius: 2, py: 0.25, px: 1, pl: 2 }}
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
                                              void handleOpenModelMeta();
                                            }}
                                            aria-label="Model info"
                                          >
                                            <MemoryOutlinedIcon fontSize="small" />
                                          </IconButton>
                                        ) : null}
                                      </ListItemButton>
                                    );
                                  })}
                                </Collapse>
                              );
                            } else {
                              for (const model of group) {
                                const value = modelSelectKey(model.provider, model.name);
                                const isSelected = value === selectedModel;
                                items.push(
                                  <ListItemButton
                                    key={value}
                                    selected={isSelected}
                                    onClick={() => handleModelChange(value)}
                                    sx={{ borderRadius: 2, py: 0.25, px: 1 }}
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
                                          void handleOpenModelMeta();
                                        }}
                                        aria-label="Model info"
                                      >
                                        <MemoryOutlinedIcon fontSize="small" />
                                      </IconButton>
                                    ) : null}
                                  </ListItemButton>
                                );
                              }
                            }
                          }
                          return items;
                        })()}
                      </List>
                    </Collapse>
                  </Box>

                  <Divider />

                  <Box data-tour="reasoning-effort-section">
                    <ListItemButton
                      onClick={() => toggleRightSection("reasoningEffortSectionOpen")}
                      sx={{ mx: -2, px: 2, py: 0.5 }}
                      disabled={!reasoningEffortSupported}
                    >
                      <Typography variant="overline" color="text.secondary" sx={{ flexGrow: 1 }}>
                        Reasoning Effort
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
                        {reasoningEffortSupported && selectedReasoningEffort ? selectedReasoningEffort : ""}
                      </Typography>
                      {reasoningEffortSectionOpen ? <ExpandLessOutlinedIcon fontSize="small" /> : <ExpandMoreOutlinedIcon fontSize="small" />}
                    </ListItemButton>
                    <Collapse in={reasoningEffortSectionOpen}>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                        {REASONING_EFFORT_OPTIONS.map((val) => (
                          <Chip
                            key={val}
                            label={val}
                            size="small"
                            variant={selectedReasoningEffort === val ? "filled" : "outlined"}
                            color={selectedReasoningEffort === val ? "primary" : "default"}
                            clickable
                            onClick={() =>
                              handleReasoningEffortChange(selectedReasoningEffort === val ? undefined : val)
                            }
                            disabled={!reasoningEffortSupported}
                          />
                        ))}
                      </Stack>
                    </Collapse>
                  </Box>

                  <Divider />

                  <Box data-tour="temperature-section">
                    <ListItemButton
                      onClick={() => toggleRightSection("tempSectionOpen")}
                      sx={{ mx: -2, px: 2, py: 0.5 }}
                    >
                      <Typography variant="overline" color="text.secondary" sx={{ flexGrow: 1 }}>
                        Temperature
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
                        {selectedTemperature != null ? selectedTemperature.toFixed(1) : ""}
                      </Typography>
                      {tempSectionOpen ? <ExpandLessOutlinedIcon fontSize="small" /> : <ExpandMoreOutlinedIcon fontSize="small" />}
                    </ListItemButton>
                    <Collapse in={tempSectionOpen}>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                        {[0.0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.0].map((val) => (
                          <Chip
                            key={val}
                            label={val.toFixed(1)}
                            size="small"
                            variant={selectedTemperature === val ? "filled" : "outlined"}
                            color={selectedTemperature === val ? "primary" : "default"}
                            clickable
                            onClick={() =>
                              handleTemperatureChange(selectedTemperature === val ? undefined : val)
                            }
                            disabled={!temperatureSupported}
                          />
                        ))}
                      </Stack>
                    </Collapse>
                  </Box>

                  <Divider />

                  <Box data-tour="max-tokens-section">
                    <ListItemButton
                      onClick={() => toggleRightSection("maxTokensSectionOpen")}
                      sx={{ mx: -2, px: 2, py: 0.5 }}
                    >
                      <Typography variant="overline" color="text.secondary" sx={{ flexGrow: 1 }}>
                        Max Output Tokens
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
                        {selectedConversation.maxOutputTokens ?? ""}
                      </Typography>
                      {maxTokensSectionOpen ? <ExpandLessOutlinedIcon fontSize="small" /> : <ExpandMoreOutlinedIcon fontSize="small" />}
                    </ListItemButton>
                    <Collapse in={maxTokensSectionOpen}>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                        {[5, 10, 25, 50, 100, 250, 500, 1000].map((val) => (
                          <Chip
                            key={val}
                            label={val}
                            size="small"
                            variant={selectedConversation.maxOutputTokens === val ? "filled" : "outlined"}
                            color={selectedConversation.maxOutputTokens === val ? "primary" : "default"}
                            clickable
                            onClick={() =>
                              handleMaxOutputTokensChange(
                                selectedConversation.maxOutputTokens === val ? undefined : val
                              )
                            }
                          />
                        ))}
                      </Stack>
                    </Collapse>
                  </Box>

                  <Divider />

                  <Box data-tour="tools-section">
                    <ListItemButton
                      onClick={() => toggleRightSection("toolsSectionOpen")}
                      sx={{ mx: -2, px: 2, py: 0.5 }}
                    >
                      <Typography variant="overline" color="text.secondary" sx={{ flexGrow: 1 }}>
                        Tools
                      </Typography>
                      {toolsSectionOpen ? <ExpandLessOutlinedIcon fontSize="small" /> : <ExpandMoreOutlinedIcon fontSize="small" />}
                    </ListItemButton>
                    <Collapse in={toolsSectionOpen}>
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
                            disabled={!selectedConversation || selectedConversation.activeToolIds.length === 0}
                            onClick={() => {
                              if (selectedConversation) {
                                updateConversation(selectedConversation.id, (c) => ({
                                  ...c,
                                  activeToolIds: [],
                                  updatedAt: new Date().toISOString(),
                                }));
                              }
                            }}
                          />
                        </Stack>
                        {/* ── Built-in tools subsection ── */}
                        {/* Force-expand subsections when a filter or search is active */}
                        <Box>
                          {(() => {
                            const hasActiveTool = builtinTools.some((t) => selectedConversation.activeToolIds.includes(t.id));
                            return (
                              <ListItemButton
                                onClick={() => toggleSubsection("tools-builtin")}
                                selected={hasActiveTool}
                                sx={{ px: 1, py: 0.25, borderRadius: 1 }}
                              >
                                <ListItemText
                                  primary="built-in"
                                  primaryTypographyProps={{ variant: "caption", color: hasActiveTool ? "primary" : "text.secondary", fontWeight: 600 }}
                                />
                                <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
                                  {builtinTools.length}
                                </Typography>
                                {(hasToolFilter || isSubsectionOpen("tools-builtin")) ? <ExpandLessOutlinedIcon sx={{ fontSize: 14 }} /> : <ExpandMoreOutlinedIcon sx={{ fontSize: 14 }} />}
                              </ListItemButton>
                            );
                          })()}
                          <Collapse in={hasToolFilter || isSubsectionOpen("tools-builtin")}>
                            <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                              {builtinTools.map((tool, toolIdx) => (
                                <Paper key={tool.id} data-tool-id={tool.id} {...(toolIdx === 0 ? { "data-tour": "tool-card" } : {})} variant="outlined" sx={{ p: 1.5 }}>
                                  <FormControlLabel
                                    control={
                                      <Checkbox
                                        checked={selectedConversation.activeToolIds.includes(tool.id)}
                                        onChange={() => handleToggleConversationTool(tool.id)}
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
                                  {renderToolSchema(tool)}
                                </Paper>
                              ))}

                            </Stack>
                          </Collapse>
                        </Box>

                        {/* ── MCP tools subsections (one per server) ── */}
                        {(() => {
                          let toolCardAssigned = builtinTools.length > 0;
                          return Array.from(mcpServers.entries()).map(([serverName, serverTools]) => {
                          const key = `tools-mcp-${serverName}`;
                          return (
                            <Box key={serverName}>
                              {(() => {
                                const hasActiveTool = serverTools.some((t) => selectedConversation.activeToolIds.includes(t.id));
                                return (
                                  <ListItemButton
                                    onClick={() => toggleSubsection(key)}
                                    selected={hasActiveTool}
                                    sx={{ px: 1, py: 0.25, borderRadius: 1 }}
                                  >
                                    <HubOutlinedIcon sx={{ fontSize: 14, mr: 0.5, color: hasActiveTool ? "primary.main" : "text.secondary" }} />
                                    <ListItemText
                                      primary={serverName}
                                      primaryTypographyProps={{ variant: "caption", color: hasActiveTool ? "primary" : "text.secondary", fontWeight: 600 }}
                                    />
                                    <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
                                      {serverTools.length}
                                    </Typography>
                                    {(hasToolFilter || isSubsectionOpen(key)) ? <ExpandLessOutlinedIcon sx={{ fontSize: 14 }} /> : <ExpandMoreOutlinedIcon sx={{ fontSize: 14 }} />}
                                  </ListItemButton>
                                );
                              })()}
                              <Collapse in={hasToolFilter || isSubsectionOpen(key)}>
                                <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                                  {serverTools.map((tool) => {
                                    const assignTourCard = !toolCardAssigned;
                                    if (assignTourCard) toolCardAssigned = true;
                                    return (
                                    <Paper key={tool.id} data-tool-id={tool.id} {...(assignTourCard ? { "data-tour": "tool-card" } : {})} variant="outlined" sx={{ p: 1.5 }}>
                                      <FormControlLabel
                                        control={
                                          <Checkbox
                                            checked={selectedConversation.activeToolIds.includes(tool.id)}
                                            onChange={() => handleToggleConversationTool(tool.id)}
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
                                      {renderToolSchema(tool)}
                                    </Paper>
                                    );
                                  })}
                                </Stack>
                              </Collapse>
                            </Box>
                          );
                        });
                        })()}
                      </Stack>
                    </Collapse>
                  </Box>

                  <Divider />

                  <Box>
                    <ListItemButton
                      onClick={() => toggleRightSection("clientSectionOpen")}
                      sx={{ mx: -2, px: 2, py: 0.5 }}
                    >
                      <Typography variant="overline" color="text.secondary" sx={{ flexGrow: 1 }}>
                        Client
                      </Typography>
                      {clientSectionOpen ? <ExpandLessOutlinedIcon fontSize="small" /> : <ExpandMoreOutlinedIcon fontSize="small" />}
                    </ListItemButton>
                    <Collapse in={clientSectionOpen}>
                      <Stack sx={{ mt: 0.5 }}>
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={renderMarkdown}
                              onChange={() => updateSidebar({ renderMarkdown: !renderMarkdown })}
                              size="small"
                            />
                          }
                          label={<Typography variant="body2">Render markdown</Typography>}
                        />
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={showTokens}
                              onChange={() => updateSidebar({ showTokens: !showTokens })}
                              size="small"
                            />
                          }
                          label={<Typography variant="body2">Show tokens</Typography>}
                        />
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={showExamples}
                              onChange={() => updateSidebar({ showExamples: !showExamples })}
                              size="small"
                            />
                          }
                          label={<Typography variant="body2">Show examples</Typography>}
                        />
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={showTour}
                              onChange={() => updateSidebar({ showTour: !showTour })}
                              size="small"
                            />
                          }
                          label={<Typography variant="body2">Show tour</Typography>}
                        />

                        <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, mb: 0.5 }}>
                          Hide
                        </Typography>
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={hideSystemPrompt}
                              onChange={() => updateSidebar({ hideSystemPrompt: !hideSystemPrompt })}
                              size="small"
                            />
                          }
                          label={<Typography variant="body2">System prompt</Typography>}
                        />

                        <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, mb: 0.5 }}>
                          Collapse by default
                        </Typography>
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={collapseReasoning}
                              onChange={() => updateSidebar({ collapseReasoning: !collapseReasoning })}
                              size="small"
                            />
                          }
                          label={<Typography variant="body2">Reasoning</Typography>}
                        />
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={collapseToolCalls}
                              onChange={() => updateSidebar({ collapseToolCalls: !collapseToolCalls })}
                              size="small"
                            />
                          }
                          label={<Typography variant="body2">Tool calls</Typography>}
                        />
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={collapseTools}
                              onChange={() => updateSidebar({ collapseTools: !collapseTools })}
                              size="small"
                            />
                          }
                          label={<Typography variant="body2">Tools</Typography>}
                        />
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={collapseServerMessages}
                              onChange={() => updateSidebar({ collapseServerMessages: !collapseServerMessages })}
                              size="small"
                            />
                          }
                          label={<Typography variant="body2">Server / harness messages</Typography>}
                        />
                      </Stack>
                    </Collapse>
                  </Box>
                </Stack>
              </Box>
            ) : null}
          </Box>
        </Paper>
      </Box>

      <Dialog open={deleteConfirmId != null} onClose={() => setDeleteConfirmId(null)}>
        <DialogTitle>Delete conversation?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            This will permanently remove the conversation and all its messages.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              if (deleteConfirmId) handleDeleteConversation(deleteConfirmId);
              setDeleteConfirmId(null);
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!wsConnected}>
        <DialogTitle>Backend not connected</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Unable to connect to the backend server. All model requests are routed through the backend.
          </Alert>
          <Typography variant="body2" color="text.secondary">
            Make sure the server is running with <code>make dev</code> and try refreshing the page.
          </Typography>
        </DialogContent>
      </Dialog>

      <Dialog
        open={modelMetaOpen}
        onClose={() => setModelMetaOpen(false)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>{selectedConversation?.model ?? "Model metadata"}</DialogTitle>
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
          <Button onClick={() => setModelMetaOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <JsonPreviewDialog
        open={requestJsonOpen}
        onClose={() => setRequestJsonOpen(false)}
        title="Request JSON"
        subtitle="OpenAI-compatible format"
        json={requestJsonPreview}
      />

      <JsonPreviewDialog
        open={inspectStep != null}
        onClose={() => setInspectStep(null)}
        title={inspectStep ? (inspectStep.id === "tools-card" ? "tools" : inspectStep.kind.replace("_", " ")) : ""}
        subtitle="OpenAI-compatible format"
        json={inspectStep ? (() => {
          if (inspectStep.id === "tools-card") return inspectStep.content;
          const msgs = toOpenAIMessages([inspectStep]);
          if (msgs.length === 0) return "(not sent to LLM)";
          return JSON.stringify(msgs.length === 1 ? msgs[0] : msgs, null, 2);
        })() : ""}
      />
    </Box>
  );
}

function SectionSearchField({ value, onChange, placeholder, dataTour }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  dataTour?: string;
}) {
  return (
    <TextField
      data-tour={dataTour}
      size="small"
      placeholder={placeholder ?? "Search…"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchOutlinedIcon sx={{ fontSize: 14 }} />
            </InputAdornment>
          ),
          sx: { py: 0.25, px: 1, fontSize: "0.8rem" },
        },
        htmlInput: { sx: { py: "4px" } },
      }}
      sx={{ mb: 0.5 }}
      fullWidth
    />
  );
}

function renderToolSchema(tool: ToolDefinition) {
  try {
    const schema = JSON.parse(tool.inputSchema) as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    const props = schema.properties;
    if (!props || Object.keys(props).length === 0) return null;
    const required = schema.required ?? [];
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
                <td style={{ padding: "2px 8px", fontFamily: "monospace", color: "gray" }}>{def.type ?? "—"}</td>
                <td style={{ textAlign: "center", padding: "2px 4px" }}>
                  <Checkbox checked={required.includes(name)} size="small" disabled sx={{ p: 0 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
    );
  } catch {
    return (
      <Typography variant="caption" sx={{ mt: 1, display: "block", whiteSpace: "pre-wrap", fontFamily: "monospace", color: "text.secondary" }}>
        {tool.inputSchema}
      </Typography>
    );
  }
}

function isVisibleTranscriptStep(step: ConversationStep) {
  return (
    step.kind === "user" ||
    step.kind === "assistant" ||
    step.kind === "reasoning" ||
    step.kind === "tool_result" ||
    step.kind === "meta"
  );
}

/** Thread depth for visual nesting. Level 0 = no bar, 1 = one bar, 2 = two bars. */
function stepThreadDepth(kind: ConversationStep["kind"]): number {
  switch (kind) {
    case "reasoning":
    case "tool_call":
    case "tool_result":
      return 1;
    case "meta":
      return 2;
    default:
      return 0;
  }
}

/**
 * Wraps an array of already-rendered step elements with thread-bar
 * containers based on each step's depth level.  Consecutive steps at
 * depth >= N are grouped and wrapped in a flex row with N vertical bars.
 */
function wrapWithThreadBars(
  items: { key: string; depth: number; element: React.ReactNode }[],
  theme: Theme,
): React.ReactNode[] {
  const barColor = "var(--thread-bar-color)";
  const result: React.ReactNode[] = [];
  let i = 0;

  while (i < items.length) {
    const item = items[i];
    if (item.depth === 0) {
      result.push(item.element);
      i++;
      continue;
    }

    // Collect consecutive run at depth >= 1
    const group: typeof items = [];
    while (i < items.length && items[i].depth >= 1) {
      group.push(items[i]);
      i++;
    }

    // Recursively wrap depth-2 items within this group
    const innerItems = group.map((g) => ({
      key: g.key,
      depth: g.depth - 1,
      element: g.element,
    }));
    const innerContent = wrapWithThreadBars(innerItems, theme);

    result.push(
      <Box key={`thread-${group[0].key}`} sx={{ display: "flex", gap: 1.5 }}>
        <Box
          sx={{
            width: 3,
            flexShrink: 0,
            borderRadius: 1,
            backgroundColor: barColor,
          }}
        />
        <Stack spacing={2} sx={{ flex: 1, minWidth: 0 }}>
          {innerContent}
        </Stack>
      </Box>,
    );
  }

  return result;
}

// ── Step Card ────────────────────────────────────────────────────────

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

function StepCard({
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

function formatStepHeader(step: ConversationStep): string {
  if (step.kind === "tool_result") {
    return "tool call response";
  }
  if (step.kind === "meta" && step.metaEvent) {
    const kind = step.metaEvent.kind;
    if (kind === "mcp_call") {
      const tool = (step.metaEvent.data?.tool as string) ?? "";
      return `Server Execution${tool ? `: ${tool}` : ""}`;
    }
    if (kind === "mcp_result") {
      const tool = (step.metaEvent.data?.tool as string) ?? "";
      return `Server Result${tool ? `: ${tool}` : ""}`;
    }
    return step.metaEvent.kind.replace(/_/g, " ");
  }
  return step.kind.replace("_", " ");
}

function formatStepFooterMeta(step: ConversationStep): string | null {
  const parts: string[] = [];

  if (step.model && (step.kind === "assistant" || step.kind === "reasoning")) {
    parts.push(step.model);
  }

  if (step.kind === "meta" && step.metaEvent?.kind === "search_result" && step.content) {
    parts.push(step.content);
  } else if (step.kind === "meta" && step.metaEvent?.durationMs != null) {
    parts.push(`${step.metaEvent.durationMs}ms`);
  }

  if (step.usage) {
    if (step.usage.inputTokens != null) parts.push(`in: ${step.usage.inputTokens.toLocaleString()}`);
    if (step.usage.outputTokens != null) parts.push(`out: ${step.usage.outputTokens.toLocaleString()}`);
    if (step.usage.stopReason) parts.push(`stop: ${step.usage.stopReason}`);
  }

  return parts.length > 0 ? parts.join(" / ") : null;
}

function getStepBackgroundColor(
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
    default:
      return alpha(theme.palette.background.paper, 0.92);
  }
}

function findResponseStartIndex(steps: ConversationStep[], assistantIndex: number) {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const step = steps[index];

    if (step.kind === "user" || step.kind === "system" || step.kind === "tool_result") {
      return index + 1;
    }
  }

  return 0;
}

/**
 * Build a composite key for the model Select so that models with the same
 * name on different providers remain distinguishable.
 */
function modelSelectKey(provider: string | undefined, name: string): string {
  return provider ? `${provider}:${name}` : name;
}

function parseModelSelectKey(key: string): { provider?: string; model: string } {
  const idx = key.indexOf(":");
  if (idx === -1) return { model: key };
  return { provider: key.slice(0, idx), model: key.slice(idx + 1) };
}

function renderModelLabel(model: OllamaModel) {
  return (
    <span style={{ display: "flex", gap: "6px" }}>
      <span style={{ width: "1.2em", flexShrink: 0, textAlign: "center" }}>
        {isReasoningModel(model) ? "\u2728" : ""}
      </span>
      <span>{model.name}</span>
    </span>
  );
}

function groupModelsByProvider(models: OllamaModel[]) {
  const providers = new Map<string, OllamaModel[]>();
  for (const model of models) {
    const key = model.providerName ?? "Local";
    const group = providers.get(key) ?? [];
    group.push(model);
    providers.set(key, group);
  }


  // If there's only one provider, skip the subheaders
  if (providers.size <= 1) {
    return models.map((model) => {
      const value = modelSelectKey(model.provider, model.name);
      return (
        <MenuItem key={value} value={value}>
          {renderModelLabel(model)}
        </MenuItem>
      );
    });
  }

  const elements: React.ReactNode[] = [];
  for (const [providerName, group] of providers) {
    elements.push(
      <ListSubheader key={`header-${providerName}`}>{providerName}</ListSubheader>
    );
    for (const model of group) {
      const value = modelSelectKey(model.provider, model.name);
      elements.push(
        <MenuItem key={value} value={value}>
          {renderModelLabel(model)}
        </MenuItem>
      );
    }
  }

  return elements;
}

/** Known reasoning model name patterns (for providers that don't report capabilities). */
const REASONING_MODEL_PATTERNS = [
  // OpenAI reasoning models
  /\bo1\b/i,
  /\bo3\b/i,
  /\bo4[-\s]?mini\b/i,
  // MiniMax reasoning models
  /\bMiniMax-M1\b/i,
  /\bMiniMax-M2\.5\b/i,
  /\bMiniMax-M2\.7\b/i,
];

function isReasoningModel(model: OllamaModel): boolean {
  if (model.capabilities?.includes("thinking")) return true;
  return REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(model.name));
}

function isEmbeddingModel(model: OllamaModel) {
  const families = [...(model.families ?? []), model.family, model.parentModel]
    .filter(Boolean)
    .map((value) => value!.toLowerCase());

  const embeddingFamilies = [
    "bert",
    "bge",
    "gte",
    "embeddinggemma",
    "nomic-bert",
    "snowflake-arctic-embed",
    "all-minilm",
    "mxbai-embed-large",
  ];

  if (families.some((family) => embeddingFamilies.some((token) => family.includes(token)))) {
    return true;
  }

  return /^\d+\s*d$/i.test(model.parameterSize?.trim() ?? "");
}

function supportsTemperature(model: OllamaModel | undefined): boolean {
  if (!model) {
    return false;
  }

  return !isEmbeddingModel(model);
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


function JsonPreviewDialog({ open, onClose, title, subtitle, json }: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle: string;
  json: string;
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

function prettyPrintJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

async function copyTextToClipboard(value: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error("Copy command failed.");
  }
}
