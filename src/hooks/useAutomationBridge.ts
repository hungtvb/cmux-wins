import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
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
  activeWorkspaceIdRef: MutableRefObject<string>;
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
  setActiveWorkspaceId: Dispatch<SetStateAction<string>>;
  setAttention: Dispatch<SetStateAction<Record<string, string>>>;
};

export function useAutomationBridge({
  workspaces,
  activeWorkspaceId,
  attention,
  activeWorkspaceIdRef,
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
    let unlisten: UnlistenFn | undefined;
    let readyTransition: Promise<unknown> = Promise.resolve();
    const sessionId = crypto.randomUUID();

    void listen<AutomationRequestEvent>("automation-request", (event) => {
      if (disposed) return;

      let resolution: Record<string, unknown>;
      try {
        const previous = stateRef.current;
        const outcome = applyWorkspaceAutomation(
          previous,
          event.payload.method,
          event.payload.params,
        );
        stateRef.current = outcome.state;
        // Functional updates: never clobber a concurrent user edit that
        // landed between the snapshot and this commit.
        setWorkspaces(() => outcome.state.workspaces);
        setActiveWorkspaceId((current) => {
          // Keep the ref in lockstep with automation-driven switches so
          // attention/unread logic never reads a stale active workspace.
          if (current === outcome.state.activeWorkspaceId) return current;
          activeWorkspaceIdRef.current = outcome.state.activeWorkspaceId;
          return outcome.state.activeWorkspaceId;
        });

        if (event.payload.method === "pane.close") {
          const paneId = event.payload.params.paneId;
          if (typeof paneId === "string") {
            setAttention((current) => {
              const next = { ...current };
              delete next[paneId];
              return next;
            });
          }
        } else if (event.payload.method === "workspace.close") {
          const workspaceId = event.payload.params.workspaceId;
          const closedWorkspace =
            typeof workspaceId === "string"
              ? previous.workspaces.find((workspace) => workspace.id === workspaceId)
              : undefined;
          if (closedWorkspace) {
            setAttention((current) => {
              const next = { ...current };
              for (const pane of closedWorkspace.panes) delete next[pane.id];
              return next;
            });
          }
        }

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
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        readyTransition = invoke("set_automation_frontend_ready", {
          sessionId,
          ready: true,
        }).catch(() => {
          // The bridge remains not-ready and CLI requests fail explicitly.
        });
      })
      .catch(() => {
        // The bridge remains not-ready and CLI requests fail explicitly.
      });

    return () => {
      disposed = true;
      unlisten?.();
      void readyTransition.finally(() =>
        invoke("set_automation_frontend_ready", {
          sessionId,
          ready: false,
        }).catch(() => undefined),
      );
    };
  }, [setActiveWorkspaceId, setAttention, setWorkspaces, activeWorkspaceIdRef]);
}
