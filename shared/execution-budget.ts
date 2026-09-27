/**
 * Default per-request execution budget shared by the frontend (settings UI)
 * and the backend (tool loop). A conversation may set its own values; the
 * server caps them at its configured ceilings (see server/ws-handler.ts).
 */
export const DEFAULT_MAX_MODEL_INVOCATIONS = 8;
export const DEFAULT_MAX_TOOL_CALLS = 32;
