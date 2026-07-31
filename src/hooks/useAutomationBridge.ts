import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  applyWorkspaceAutomation,
  WorkspaceAutomationError,
  type WorkspaceAutomationState,
} from "../automation/workspaceAutomation";
import type { Workspace } from "../types";

type AutomationRequestEvent = {
  commandId: number;
  method: string;
  params: Record<string, unknown>;
};

type UseAutomationBridgeOptions = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  attention: Record<string, string>;
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
  setActiveWorkspaceId: Dispatch<SetStateAction<string>>;
  setAttention: Dispatch<SetStateAction<Record<string, string>>>;
};

export function useAutomationBridge({
  workspaces,
  activeWorkspaceId,
  attention,
  setWorkspaces,
  setActiveWorkspaceId,
  setAttention,
}: UseAutomationBridgeOptions) {
  const stateRef = useRef<WorkspaceAutomationState>({
    workspaces,
    activeWorkspaceId,
    attention,
  });

  useEffect(() => {
    stateRef.current = { ...stateRef.current, workspaces };
  }, [workspaces]);

  useEffect(() => {
    stateRef.current = { ...stateRef.current, activeWorkspaceId };
  }, [activeWorkspaceId]);

  useEffect(() => {
    stateRef.current = { ...stateRef.current, attention };
  }, [attention]);

  useEffect(() => {
    let disposed = false;

    const unlistenPromise = listen<AutomationRequestEvent>("automation-request", (event) => {
      if (disposed) return;

      let resolution: Record<string, unknown>;
      try {
        const outcome = applyWorkspaceAutomation(
          stateRef.current,
          event.payload.method,
          event.payload.params,
        );
        stateRef.current = outcome.state;
        setWorkspaces(outcome.state.workspaces);
        setActiveWorkspaceId(outcome.state.activeWorkspaceId);
        setAttention(outcome.state.attention);

        resolution = {
          commandId: event.payload.commandId,
          ok: true,
          result: outcome.result,
        };
      } catch (cause) {
        const error =
          cause instanceof WorkspaceAutomationError
            ? cause
            : new WorkspaceAutomationError("UI_ERROR", String(cause));
        resolution = {
          commandId: event.payload.commandId,
          ok: false,
          errorCode: error.code,
          errorMessage: error.message,
        };
      }

      void invoke("resolve_automation_request", { resolution }).catch(() => {
        // Rust owns the timeout and late-response cleanup path.
      });
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [setActiveWorkspaceId, setAttention, setWorkspaces]);
}
