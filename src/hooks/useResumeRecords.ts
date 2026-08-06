import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ResumeRecord } from "../resumeModel";

const POLL_INTERVAL_MS = 5_000;

/**
 * Polls the Rust resume store for agent session records. The store is
 * append-only and written by agent hook scripts, so the UI cannot be notified
 * of changes directly — a lightweight poll keeps the Resume menu fresh while
 * the app is open. `refreshKey` forces an immediate re-read (e.g. when the
 * active workspace changes); pass `undefined` to disable polling.
 */
export function useResumeRecords(
  cwd: string | undefined,
  refreshKey: unknown = "",
): { records: ResumeRecord[]; refresh: () => void } {
  const [records, setRecords] = useState<ResumeRecord[]>([]);
  const disposedRef = useRef(false);
  const keyRef = useRef(refreshKey);

  const refresh = useCallback(() => {
    void invoke<ResumeRecord[]>("get_resume_records")
      .then((result) => {
        if (!disposedRef.current) setRecords(result ?? []);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    keyRef.current = refreshKey;
    refresh();
    const interval = window.setInterval(() => {
      if (keyRef.current !== refreshKey) {
        window.clearInterval(interval);
        return;
      }
      refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      disposedRef.current = true;
      window.clearInterval(interval);
    };
  }, [refresh, refreshKey, cwd]);

  return { records, refresh };
}
