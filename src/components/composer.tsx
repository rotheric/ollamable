"use client";

import { Box, IconButton, InputAdornment, TextField } from "@mui/material";
import StopOutlinedIcon from "@mui/icons-material/StopOutlined";
import { contentColumnWidth } from "@/src/components/layout";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Both sidebars are open, so the column may use its wider measure. */
  wide: boolean;
  streaming: boolean;
  onSend: () => void;
  onStop: () => void;
}

/** The user prompt field. Enter sends, Shift+Enter breaks the line; while a response streams it offers Stop. */
export function Composer({ value, onChange, wide, streaming, onSend, onStop }: ComposerProps) {
  return (
    <Box
      data-tour="composer"
      sx={{
        flexShrink: 0,
        width: "100%",
        maxWidth: contentColumnWidth(wide) + 48,
        transition: "max-width 0.35s ease",
        px: 2,
        pt: 1,
        pb: 2,
        scrollbarGutter: "stable",
      }}
    >
      <Box sx={{
        maxWidth: contentColumnWidth(wide),
        mx: "auto",
        transition: "max-width 0.35s ease",
      }}>
        <TextField
          label="User Prompt"
          InputLabelProps={{ shrink: true }}
          multiline
          minRows={3}
          maxRows={12}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (value.trim() && !streaming) {
                onSend();
              }
            }
          }}
          placeholder=""
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
                    onClick={onStop}
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
  );
}
