"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Box, IconButton, Paper, Typography } from "@mui/material";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import type { Conversation } from "@/src/types/chat";
import { formatTimestamp } from "@/src/lib/chat";

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

export function SortableConversationCard({
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
