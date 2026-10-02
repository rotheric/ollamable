import type { ReactNode } from "react";
import { Box, Stack } from "@mui/material";

/**
 * Wraps an array of already-rendered step elements with thread-bar
 * containers based on each step's depth level.  Consecutive steps at
 * depth >= N are grouped and wrapped in a flex row with N vertical bars.
 */
export function wrapWithThreadBars(
  items: { key: string; depth: number; element: ReactNode }[],
): ReactNode[] {
  const barColor = "var(--thread-bar-color)";
  const result: ReactNode[] = [];
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
    const innerContent = wrapWithThreadBars(innerItems);

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
