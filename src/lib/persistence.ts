import { useSyncExternalStore } from "react";

const failures = new Set<string>();
const unreadKeys = new Set<string>();
const listeners = new Set<() => void>();
let notificationPending = false;
function report(operation: "read" | "write", key: string, failed: boolean) {
  const id = `${operation}:${key}`;
  const changed = failed ? !failures.has(id) : failures.has(id);
  if (failed) failures.add(id); else failures.delete(id);
  if (!changed || notificationPending) return;
  notificationPending = true;
  queueMicrotask(() => { notificationPending = false; for (const listener of listeners) listener(); });
}
export function persistenceStatus(): string { return [...failures].sort().join(","); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function usePersistenceStatus(): boolean {
  return Boolean(useSyncExternalStore(subscribe, persistenceStatus, () => ""));
}

export function readStorage(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    unreadKeys.delete(key);
    report("read", key, false);
    return value;
  } catch {
    unreadKeys.add(key);
    report("read", key, true);
    return null;
  }
}

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22);
}

/** One optional quota retry. Never clear existing data to make room. */
export function writeStorage(key: string, value: string, quotaFallback?: () => string): boolean {
  // If hydration could not read this key, don't overwrite unknown saved data with defaults.
  if (unreadKeys.has(key)) return false;
  try {
    try { window.localStorage.setItem(key, value); }
    catch (error) {
      if (!quotaFallback || !isQuotaExceeded(error)) throw error;
      window.localStorage.setItem(key, quotaFallback());
    }
    report("write", key, false);
    return true;
  } catch {
    report("write", key, true);
    console.warn(`Could not persist ${key}; existing saved data was retained.`);
    return false;
  }
}

export function removeStorage(key: string): boolean {
  if (unreadKeys.has(key)) return false;
  try {
    window.localStorage.removeItem(key);
    report("write", key, false);
    return true;
  } catch {
    report("write", key, true);
    return false;
  }
}
