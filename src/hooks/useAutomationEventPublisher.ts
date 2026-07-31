import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import {
  diffWorkspaceEvents,
  type FrontendAutomationEvent,
  type WorkspaceEventSnapshot,
} from "../automation/workspaceEvents";
import type { Workspace } from "../types";

const MAX_EVENT_BATCH = 64;

type UseAutomationEventPublisherOptions = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  attention: Record<string, string>;
};

function batches<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function publish(events: FrontendAutomationEvent[]) {
  for (const batch of batches(events, MAX_EVENT_BATCH)) {
    await invoke("publish_frontend_automation_events", { events: batch });
  }
}

export function useAutomationEventPublisher({
  workspaces,
  activeWorkspaceId,
  attention,
}: UseAutomationEventPublisherOptions) {
  const previousRef = useRef<WorkspaceEventSnapshot>({
    workspaces,
    activeWorkspaceId,
    attention,
  });
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const current: WorkspaceEventSnapshot = {
      workspaces,
      activeWorkspaceId,
      attention,
    };
    const events = diffWorkspaceEvents(previousRef.current, current);

    // Advance the local cursor before asynchronous IPC. A slow or failed batch
    // must not make the next React render emit the same state transition again.
    previousRef.current = current;
    if (events.length === 0) return;

    queueRef.current = queueRef.current
      .catch(() => {
        // Keep subsequent state transitions publishable after a failed batch.
      })
      .then(() => publish(events))
      .catch((error) => {
        console.error("Unable to publish automation events", error);
      });
  }, [activeWorkspaceId, attention, workspaces]);
}
