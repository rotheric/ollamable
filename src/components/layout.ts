/** Shared layout measurements of the workspace shell, in pixels. */
export const APP_BAR_HEIGHT = 65;
export const SIDEBAR_WIDTH = 320;
export const SIDEBAR_COLLAPSED_WIDTH = 44;
export const RIGHT_SIDEBAR_WIDTH = 360;

/** The transcript and composer column is wider while both sidebars are open. */
export function contentColumnWidth(wide: boolean): number {
  return wide ? 900 : 700;
}
