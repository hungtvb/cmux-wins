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

type BrowserPaneProps = {
  paneId: string;
  title: string;
  url: string;
  active: boolean;
  onUrlChange: (paneId: string, url: string) => void;
  onClose: (paneId: string) => void;
};

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_URL;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // Fall through and prepend https:// below.
  }

  return new URL(`https://${trimmed}`).toString();
}

function BrowserPaneComponent({
  paneId,
  title,
  url,
  active,
  onUrlChange,
  onClose,
}: BrowserPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const urlRef = useRef(url);
  const activeRef = useRef(active);
  const createdRef = useRef(false);
  const [draftUrl, setDraftUrl] = useState(url);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    urlRef.current = url;
    setDraftUrl(url);
  }, [url]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const syncBounds = useCallback(async () => {
    const host = hostRef.current;
    if (!host) return;

    const bounds = host.getBoundingClientRect();
    if (bounds.width < 2 || bounds.height < 2) return;

    const payload = {
      paneId,
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };

    try {
      if (!createdRef.current) {
        await invoke("create_browser_pane", { ...payload, url: urlRef.current });
        createdRef.current = true;
        if (!activeRef.current) {
          await invoke("hide_browser_pane", { paneId });
        }
      } else {
        await invoke("set_browser_pane_bounds", payload);
      }
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  }, [paneId]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
      createdRef.current = false;
      void invoke("close_browser_pane", { paneId });
    };
  }, [paneId, syncBounds]);

  useEffect(() => {
    activeRef.current = active;
    if (!createdRef.current) {
      if (active) void syncBounds();
      return;
    }

    void invoke(active ? "show_browser_pane" : "hide_browser_pane", { paneId }).catch((cause) =>
      setError(String(cause)),
    );
    if (active) void syncBounds();
  }, [active, paneId, syncBounds]);

  const navigate = useCallback(
    async (nextValue: string) => {
      const nextUrl = normalizeUrl(nextValue);
      try {
        if (!createdRef.current) await syncBounds();
        await invoke("navigate_browser_pane", { paneId, url: nextUrl });
        urlRef.current = nextUrl;
        setDraftUrl(nextUrl);
        onUrlChange(paneId, nextUrl);
        setError(null);
      } catch (cause) {
        setError(String(cause));
      }
    },
    [onUrlChange, paneId, syncBounds],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void navigate(draftUrl);
  };

  const runBrowserAction = (command: string) => {
    void invoke(command, { paneId }).catch((cause) => setError(String(cause)));
  };

  const close = () => {
    void invoke("close_browser_pane", { paneId });
    createdRef.current = false;
    onClose(paneId);
  };

  return (
    <section className="browser-pane">
      <header className="browser-pane__header">
        <div className="browser-pane__title" title={title}>
          <Globe2 size={14} />
          <span>{title}</span>
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
