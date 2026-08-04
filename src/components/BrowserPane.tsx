import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Globe2,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  BROWSER_PANE_EVENT_NAME,
  feedbackForBrowserEvent,
  normalizeBrowserPaneEvent,
  type BrowserPaneFeedback,
} from "../browserPaneState";

const DEFAULT_URL = "https://github.com";
const EXPLICIT_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const NAVIGATION_TIMEOUT_MS = 30_000;

type BrowserPaneProps = {
  paneId: string;
  title: string;
  url: string;
  active: boolean;
  focused: boolean;
  onFocus: () => void;
  onUrlChange: (paneId: string, url: string) => void;
  onTitleChange: (paneId: string, title: string) => void;
  onClose: (paneId: string) => void;
};

type BrowserBounds = {
  paneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_URL;

  const candidate = EXPLICIT_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Browser URL scheme is not allowed: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Browser URLs cannot contain embedded credentials");
  }
  if (parsed.toString().length > 2_048) {
    throw new Error("Browser URL exceeds the 2048-character limit");
  }

  return parsed.toString();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function BrowserPaneComponent({
  paneId,
  title,
  url,
  active,
  focused,
  onFocus,
  onUrlChange,
  onTitleChange,
  onClose,
}: BrowserPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const urlRef = useRef(url);
  const titleRef = useRef(title);
  const retryUrlRef = useRef(url);
  const activeRef = useRef(active);
  const createdRef = useRef(false);
  const disposedRef = useRef(false);
  const closeRequestedRef = useRef(false);
  const addressEditingRef = useRef(false);
  const creationRef = useRef<Promise<void> | null>(null);
  const listenerReadyRef = useRef<Promise<void>>(Promise.resolve());
  const loadingTimerRef = useRef<number | undefined>(undefined);
  const [draftUrl, setDraftUrl] = useState(url);
  const [loading, setLoading] = useState(false);
  const [nativeReady, setNativeReady] = useState(false);
  const [feedback, setFeedback] = useState<BrowserPaneFeedback | null>(null);

  useEffect(() => {
    urlRef.current = url;
    retryUrlRef.current = url;
    if (!addressEditingRef.current) setDraftUrl(url);
  }, [url]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const clearLoadingTimer = useCallback(() => {
    if (loadingTimerRef.current !== undefined) {
      window.clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = undefined;
    }
  }, []);

  const finishLoading = useCallback(() => {
    clearLoadingTimer();
    setLoading(false);
  }, [clearLoadingTimer]);

  const showError = useCallback(
    (cause: unknown, retryable = true) => {
      finishLoading();
      setFeedback({
        tone: "error",
        message: errorMessage(cause),
        retryable,
      });
    },
    [finishLoading],
  );

  const beginLoading = useCallback(
    (nextUrl?: string) => {
      clearLoadingTimer();
      if (nextUrl) retryUrlRef.current = nextUrl;
      setFeedback(null);
      setLoading(true);
      loadingTimerRef.current = window.setTimeout(() => {
        loadingTimerRef.current = undefined;
        if (disposedRef.current) return;
        setLoading(false);
        setFeedback({
          tone: "error",
          message: "The page did not finish loading within 30 seconds.",
          retryable: true,
        });
      }, NAVIGATION_TIMEOUT_MS);
    },
    [clearLoadingTimer],
  );

  const applyObservedUrl = useCallback(
    (nextUrl: string | undefined) => {
      if (!nextUrl) return;
      retryUrlRef.current = nextUrl;
      if (urlRef.current !== nextUrl) {
        urlRef.current = nextUrl;
        onUrlChange(paneId, nextUrl);
      }
      if (!addressEditingRef.current) setDraftUrl(nextUrl);
    },
    [onUrlChange, paneId],
  );

  const handleBrowserEvent = useCallback(
    (payload: unknown) => {
      const event = normalizeBrowserPaneEvent(payload);
      if (!event || event.paneId !== paneId || disposedRef.current) return;

      switch (event.kind) {
        case "load-started":
          applyObservedUrl(event.url);
          beginLoading(event.url);
          return;
        case "load-finished":
          applyObservedUrl(event.url);
          finishLoading();
          setFeedback((current) => (current?.tone === "notice" ? current : null));
          return;
        case "title-changed":
          if (event.title && event.title !== titleRef.current) {
            titleRef.current = event.title;
            onTitleChange(paneId, event.title);
          }
          return;
        default: {
          const nextFeedback = feedbackForBrowserEvent(event);
          if (nextFeedback) {
            if (event.kind === "navigation-blocked") finishLoading();
            setFeedback(nextFeedback);
          }
        }
      }
    },
    [applyObservedUrl, beginLoading, finishLoading, onTitleChange, paneId],
  );

  const closeNativePane = useCallback(() => {
    if (closeRequestedRef.current) return;
    closeRequestedRef.current = true;

    const close = () =>
      invoke("close_browser_pane", { paneId }).catch(() => {
        // Closing is idempotent; there is no useful recovery after unmount.
      });

    const pendingCreation = creationRef.current;
    if (pendingCreation) {
      void pendingCreation.then(close, close);
    } else {
      void close();
    }
  }, [paneId]);

  const ensureCreated = useCallback(
    async (bounds: BrowserBounds) => {
      if (createdRef.current) return;
      if (disposedRef.current) throw new Error("Browser pane was disposed during creation");

      await listenerReadyRef.current;
      if (disposedRef.current) throw new Error("Browser pane was disposed during creation");

      if (!creationRef.current) {
        beginLoading(urlRef.current);
        creationRef.current = invoke("create_browser_pane", {
          ...bounds,
          url: urlRef.current,
        })
          .then(async () => {
            if (disposedRef.current) {
              await invoke("close_browser_pane", { paneId });
              return;
            }

            createdRef.current = true;
            setNativeReady(true);
            if (!activeRef.current) {
              await invoke("hide_browser_pane", { paneId });
            }
          })
          .finally(() => {
            creationRef.current = null;
          });
      }

      await creationRef.current;
    },
    [beginLoading, paneId],
  );

  const syncBounds = useCallback(async () => {
    const host = hostRef.current;
    if (!host || disposedRef.current) return;

    const rect = host.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;

    const bounds: BrowserBounds = {
      paneId,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    try {
      await ensureCreated(bounds);
      if (disposedRef.current || !createdRef.current) return;

      // Always apply the latest measurement after creation. Multiple resize
      // callbacks may share the same create promise and the first callback's
      // bounds must not overwrite a later layout.
      await invoke("set_browser_pane_bounds", bounds);
    } catch (cause) {
      if (!disposedRef.current) showError(cause);
    }
  }, [ensureCreated, paneId, showError]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    disposedRef.current = false;
    closeRequestedRef.current = false;
    setNativeReady(false);
    let animationFrame = 0;
    let unlisten: UnlistenFn | undefined;
    let observing = false;

    const scheduleSync = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => void syncBounds());
    };

    const observer = new ResizeObserver(scheduleSync);
    const listenerReady = listen<unknown>(BROWSER_PANE_EVENT_NAME, (event) => {
      handleBrowserEvent(event.payload);
    }).then((dispose) => {
      if (disposedRef.current) {
        dispose();
        return;
      }
      unlisten = dispose;
      observer.observe(host);
      observing = true;
      window.addEventListener("resize", scheduleSync);
      scheduleSync();
    });
    listenerReadyRef.current = listenerReady;

    void listenerReady.catch((cause) => {
      if (!disposedRef.current) showError(cause, false);
    });

    return () => {
      disposedRef.current = true;
      clearLoadingTimer();
      cancelAnimationFrame(animationFrame);
      if (observing) observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
      unlisten?.();
      createdRef.current = false;
      closeNativePane();
    };
  }, [clearLoadingTimer, closeNativePane, handleBrowserEvent, showError, syncBounds]);

  useEffect(() => {
    activeRef.current = active;
    if (!createdRef.current) {
      if (active) void syncBounds();
      return;
    }

    void invoke(active ? "show_browser_pane" : "hide_browser_pane", { paneId }).catch((cause) => {
      if (!disposedRef.current) showError(cause);
    });
    if (active) void syncBounds();
  }, [active, paneId, showError, syncBounds]);

  const navigate = useCallback(
    async (nextValue: string) => {
      let nextUrl: string;
      try {
        nextUrl = normalizeUrl(nextValue);
      } catch (cause) {
        showError(cause, false);
        return;
      }

      beginLoading(nextUrl);
      try {
        await syncBounds();
        if (!createdRef.current || disposedRef.current) {
          throw new Error("Browser pane is not available");
        }

        await invoke("navigate_browser_pane", { paneId, url: nextUrl });
        retryUrlRef.current = nextUrl;
        if (urlRef.current !== nextUrl) {
          urlRef.current = nextUrl;
          onUrlChange(paneId, nextUrl);
        }
        setDraftUrl(nextUrl);
      } catch (cause) {
        if (!disposedRef.current) showError(cause);
      }
    },
    [beginLoading, onUrlChange, paneId, showError, syncBounds],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void navigate(draftUrl);
  };

  const runBrowserAction = (command: string) => {
    if (!createdRef.current) return;
    setFeedback(null);
    void invoke(command, { paneId }).catch((cause) => {
      if (!disposedRef.current) showError(cause);
    });
  };

  const retry = () => {
    void navigate(retryUrlRef.current || urlRef.current);
  };

  const close = () => {
    disposedRef.current = true;
    clearLoadingTimer();
    closeNativePane();
    onClose(paneId);
  };

  const feedbackId = `browser-feedback-${paneId}`;

  return (
    <section
      className={`browser-pane${focused ? " browser-pane--focused" : ""}`}
      aria-label={`Browser pane: ${title}`}
      aria-busy={loading}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
    >
      <header className="browser-pane__header">
        <div className="browser-pane__title" title={title}>
          <Globe2 size={14} />
          <span>{title}</span>
          {loading && (
            <span className="browser-pane__loading" role="status" aria-live="polite">
              <LoaderCircle size={12} aria-hidden="true" />
              <span className="sr-only">Loading page</span>
            </span>
          )}
          {focused && <span className="pane-focus-label">Active</span>}
        </div>
        <button
          className="icon-button"
          type="button"
          title="Close browser pane"
          aria-label="Close browser pane"
          onClick={close}
        >
          <X size={15} />
        </button>
      </header>

      <form className="browser-pane__navigation" onSubmit={handleSubmit}>
        <button
          className="icon-button"
          type="button"
          title="Back"
          aria-label="Back"
          disabled={!nativeReady}
          onClick={() => runBrowserAction("browser_go_back")}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Forward"
          aria-label="Forward"
          disabled={!nativeReady}
          onClick={() => runBrowserAction("browser_go_forward")}
        >
          <ArrowRight size={15} />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Reload"
          aria-label="Reload"
          disabled={!nativeReady}
          onClick={() => runBrowserAction("reload_browser_pane")}
        >
          <RefreshCw size={14} />
        </button>
        <input
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoComplete="off"
          aria-label="Browser address"
          aria-describedby={feedback ? feedbackId : undefined}
          value={draftUrl}
          onFocus={() => {
            addressEditingRef.current = true;
          }}
          onBlur={() => {
            addressEditingRef.current = false;
            setDraftUrl(urlRef.current);
          }}
          onChange={(event) => setDraftUrl(event.target.value)}
          spellCheck={false}
        />
      </form>

      {feedback && (
        <div
          id={feedbackId}
          className={`browser-pane__feedback browser-pane__feedback--${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
          aria-live={feedback.tone === "error" ? "assertive" : "polite"}
        >
          {feedback.tone === "error" ? (
            <AlertTriangle size={14} aria-hidden="true" />
          ) : (
            <ShieldAlert size={14} aria-hidden="true" />
          )}
          <span>{feedback.message}</span>
          {feedback.retryable && (
            <button type="button" onClick={retry}>
              <RotateCcw size={12} aria-hidden="true" />
              Retry
            </button>
          )}
          <button
            className="browser-pane__feedback-dismiss"
            type="button"
            title="Dismiss browser message"
            aria-label="Dismiss browser message"
            onClick={() => setFeedback(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="browser-pane__host" ref={hostRef}>
        {!nativeReady && (
          <div className="browser-pane__status" role="status" aria-live="polite">
            {loading ? "Starting WebView2 browser surface…" : "WebView2 browser surface"}
          </div>
        )}
      </div>
    </section>
  );
}

export const BrowserPane = memo(BrowserPaneComponent);
