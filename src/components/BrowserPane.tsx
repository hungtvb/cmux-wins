import { ArrowLeft, ArrowRight, Globe2, RefreshCw, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

const DEFAULT_URL = "https://github.com";
const EXPLICIT_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

type BrowserPaneProps = {
  paneId: string;
  title: string;
  url: string;
  active: boolean;
  focused: boolean;
  onFocus: () => void;
  onUrlChange: (paneId: string, url: string) => void;
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

  return parsed.toString();
}

function BrowserPaneComponent({
  paneId,
  title,
  url,
  active,
  focused,
  onFocus,
  onUrlChange,
  onClose,
}: BrowserPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const urlRef = useRef(url);
  const activeRef = useRef(active);
  const createdRef = useRef(false);
  const disposedRef = useRef(false);
  const closeRequestedRef = useRef(false);
  const creationRef = useRef<Promise<void> | null>(null);
  const [draftUrl, setDraftUrl] = useState(url);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    urlRef.current = url;
    setDraftUrl(url);
  }, [url]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

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

      if (!creationRef.current) {
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
    [paneId],
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
      setError(null);
    } catch (cause) {
      if (!disposedRef.current) setError(String(cause));
    }
  }, [ensureCreated, paneId]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    disposedRef.current = false;
    closeRequestedRef.current = false;
    let animationFrame = 0;
    const scheduleSync = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => void syncBounds());
    };

    const observer = new ResizeObserver(scheduleSync);
    observer.observe(host);
    window.addEventListener("resize", scheduleSync);
    scheduleSync();

    return () => {
      disposedRef.current = true;
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
      createdRef.current = false;
      closeNativePane();
    };
  }, [closeNativePane, syncBounds]);

  useEffect(() => {
    activeRef.current = active;
    if (!createdRef.current) {
      if (active) void syncBounds();
      return;
    }

    void invoke(active ? "show_browser_pane" : "hide_browser_pane", { paneId }).catch((cause) => {
      if (!disposedRef.current) setError(String(cause));
    });
    if (active) void syncBounds();
  }, [active, paneId, syncBounds]);

  const navigate = useCallback(
    async (nextValue: string) => {
      try {
        const nextUrl = normalizeUrl(nextValue);
        await syncBounds();
        if (!createdRef.current || disposedRef.current) {
          throw new Error("Browser pane is not available");
        }

        await invoke("navigate_browser_pane", { paneId, url: nextUrl });
        urlRef.current = nextUrl;
        setDraftUrl(nextUrl);
        onUrlChange(paneId, nextUrl);
        setError(null);
      } catch (cause) {
        if (!disposedRef.current) setError(String(cause));
      }
    },
    [onUrlChange, paneId, syncBounds],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void navigate(draftUrl);
  };

  const runBrowserAction = (command: string) => {
    if (!createdRef.current) return;
    void invoke(command, { paneId }).catch((cause) => {
      if (!disposedRef.current) setError(String(cause));
    });
  };

  const close = () => {
    disposedRef.current = true;
    closeNativePane();
    onClose(paneId);
  };

  return (
    <section
      className={`browser-pane${focused ? " browser-pane--focused" : ""}`}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
    >
      <header className="browser-pane__header">
        <div className="browser-pane__title" title={title}>
          <Globe2 size={14} />
          <span>{title}</span>
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
          onClick={() => runBrowserAction("browser_go_back")}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Forward"
          aria-label="Forward"
          onClick={() => runBrowserAction("browser_go_forward")}
        >
          <ArrowRight size={15} />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Reload"
          aria-label="Reload"
          onClick={() => runBrowserAction("reload_browser_pane")}
        >
          <RefreshCw size={14} />
        </button>
        <input
          aria-label="Browser address"
          value={draftUrl}
          onChange={(event) => setDraftUrl(event.target.value)}
          spellCheck={false}
        />
      </form>

      <div className="browser-pane__host" ref={hostRef}>
        {error ? (
          <div className="browser-pane__status browser-pane__status--error">{error}</div>
        ) : (
          <div className="browser-pane__status">WebView2 browser surface</div>
        )}
      </div>
    </section>
  );
}

export const BrowserPane = memo(BrowserPaneComponent);
