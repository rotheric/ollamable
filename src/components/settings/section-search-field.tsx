"use client";

import { InputAdornment, TextField } from "@mui/material";
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";

export function SectionSearchField({ value, onChange, placeholder, dataTour }: {
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
