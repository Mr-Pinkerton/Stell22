"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { newRequestId } from "@/lib/request-id";
import {
  clearDraft,
  persistPendingDraft,
  readDraft,
  shouldWriteDraft,
  type DraftParseFailReason,
  type TerminalDraftPayload,
  type TerminalDraftV1,
} from "@/lib/terminal-draft-storage";

const SAVE_DEBOUNCE_MS = 300;

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function useTerminalDraft(opts: { employeeId: string; storage?: Storage }) {
  const storage = opts.storage ?? browserStorage();
  const employeeId = opts.employeeId;

  const [hydrate] = useState(() => {
    const initial = readDraft(storage, employeeId);
    return {
      parseError: initial.status === "error" ? initial.reason : null,
      draft: initial.status === "ok" ? initial.draft : null,
      clientRequestId:
        initial.status === "ok" ? initial.draft.clientRequestId : newRequestId(),
      createdAt: initial.status === "ok" ? initial.draft.createdAt : null,
    };
  });
  const [parseError, setParseError] = useState<DraftParseFailReason | null>(hydrate.parseError);
  const [draft, setDraft] = useState<TerminalDraftV1 | null>(hydrate.draft);
  const [clientRequestId, setClientRequestId] = useState(hydrate.clientRequestId);

  const clientRequestIdRef = useRef(hydrate.clientRequestId);
  const createdAtRef = useRef(hydrate.createdAt);
  const hasPersistedDraftRef = useRef(hydrate.draft != null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<TerminalDraftV1 | null>(null);

  const persistPending = useCallback((): TerminalDraftV1 | null => {
    const pending = pendingRef.current;
    if (!pending) return null;
    const wrote = persistPendingDraft(storage, pending, hasPersistedDraftRef.current);
    if (!wrote) return null;
    pendingRef.current = null;
    hasPersistedDraftRef.current = true;
    createdAtRef.current = pending.createdAt;
    return pending;
  }, [storage]);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const written = persistPending();
    if (written) setDraft(written);
  }, [persistPending]);

  const save = useCallback(
    (next: TerminalDraftPayload) => {
      const now = new Date().toISOString();
      const snapshot: TerminalDraftV1 = {
        version: 1,
        employeeId,
        clientRequestId: clientRequestIdRef.current,
        createdAt: createdAtRef.current ?? now,
        updatedAt: now,
        ...next,
      };
      if (!shouldWriteDraft(snapshot, hasPersistedDraftRef.current)) {
        pendingRef.current = null;
        return;
      }
      pendingRef.current = snapshot;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [employeeId, flush],
  );

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    createdAtRef.current = null;
    hasPersistedDraftRef.current = false;
    const nextId = newRequestId();
    clientRequestIdRef.current = nextId;
    setClientRequestId(nextId);
    clearDraft(storage, employeeId);
    setDraft(null);
    setParseError(null);
  }, [employeeId, storage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPageHide = () => {
      persistPending();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      persistPending();
    };
  }, [persistPending]);

  return {
    draft,
    parseError,
    clientRequestId,
    save,
    saveNow: flush,
    clear,
  };
}
