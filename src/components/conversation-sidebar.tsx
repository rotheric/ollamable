"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import TourOutlinedIcon from "@mui/icons-material/TourOutlined";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import type { Conversation } from "@/src/types/chat";
import { SortableConversationCard } from "@/src/components/conversation-card";
import { APP_BAR_HEIGHT, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from "@/src/components/layout";
import { orderVisibleConversations } from "@/src/lib/use-conversations";

interface ConversationSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showTour: boolean;
  conversations: Conversation[];
  conversationOrder: string[] | null;
  selectedConversationId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onStartTour: () => void;
  onViewRequestJson: () => void;
  onUpdate: (id: string, updater: (conversation: Conversation) => Conversation) => void;
  onDelete: (id: string) => void;
  onReorder: (order: string[]) => void;
}

/**
 * Left sidebar: the conversation list with selection, drag-and-drop ordering,
 * inline title and note editing, and deletion behind a confirmation.
 */
export function ConversationSidebar({
  open: sidebarOpen,
  onOpenChange,
  showTour,
  conversations,
  conversationOrder,
  selectedConversationId,
  onSelect,
  onCreate,
  onStartTour,
  onViewRequestJson,
  onUpdate,
  onDelete,
  onReorder,
}: ConversationSidebarProps) {
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const selectedNote = conversations.find((conversation) => conversation.id === selectedConversationId)?.note;
  useEffect(() => {
    setNoteDraft(selectedNote ?? "");
    setEditingNoteId(null);
  }, [selectedConversationId, selectedNote]);

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const visibleConversations = useMemo(
    () => orderVisibleConversations(conversations, conversationOrder),
    [conversations, conversationOrder]
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = visibleConversations.findIndex((c) => c.id === active.id);
    const newIndex = visibleConversations.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(visibleConversations, oldIndex, newIndex);
    onReorder(reordered.map((c) => c.id));
  }

  function handleStartTitleEdit(conversation: Conversation) {
    setEditingConversationId(conversation.id);
    setTitleDraft(conversation.title);
  }

  function handleCancelTitleEdit() {
    setEditingConversationId(null);
    setTitleDraft("");
  }

  function handleSaveTitle(id: string) {
    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      handleCancelTitleEdit();
      return;
    }

    onUpdate(id, (conversation) => ({
      ...conversation,
      title: nextTitle,
      titleEdited: true,
      updatedAt: new Date().toISOString(),
    }));
    handleCancelTitleEdit();
  }

  function handleSaveNote(id: string) {
    const note = noteDraft;
    onUpdate(id, (conversation) => ({
      ...conversation,
      note,
    }));
    setEditingNoteId(null);
  }

  function handleStartNoteEdit(conversation: Conversation) {
    setEditingNoteId(conversation.id);
    setNoteDraft(conversation.note ?? "");
  }

  function handleConfirmDelete() {
    if (deleteConfirmId) {
      if (editingConversationId === deleteConfirmId) {
        handleCancelTitleEdit();
      }
      onDelete(deleteConfirmId);
    }
    setDeleteConfirmId(null);
  }

  return (
    <>
      <Paper
        data-tour="sidebar"
        square
        onClick={sidebarOpen ? undefined : () => onOpenChange(true)}
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
              onClick={() => onOpenChange(!sidebarOpen)}
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
              onClick={onCreate}
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
                onClick={onStartTour}
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
                      onSelect={() => onSelect(conversation.id)}
                      onViewJson={(e) => { e.stopPropagation(); onViewRequestJson(); }}
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
            onClick={handleConfirmDelete}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
