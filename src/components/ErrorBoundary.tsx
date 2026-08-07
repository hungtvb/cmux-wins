import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Rendered in place of the crashed subtree. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Optional context label for the console message (e.g. "pane"). */
  label?: string;
  onError?: (error: Error, info: ErrorInfo) => void;
};

type ErrorBoundaryState = {
  error: Error | null;
};

/**
 * Catches render/lifecycle errors in a subtree so a single faulty pane or
 * overlay cannot blank the whole app. App-level boundaries keep TonyMux
 * usable; pane-level boundaries isolate a crashed terminal/browser pane.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const { onError, label } = this.props;
    console.error(`[ErrorBoundary${label ? `:${label}` : ""}]`, error, info);
    onError?.(error, info);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }

    return (
      <div
        role="alert"
        className="error-boundary"
        style={{
          padding: "14px 16px",
          borderRadius: "10px",
          border: "1px solid rgba(255,90,90,0.4)",
          background: "rgba(255,90,90,0.08)",
          color: "inherit",
          fontSize: "13px",
          lineHeight: 1.5,
        }}
      >
        <strong>Something went wrong rendering this view.</strong>
        <div style={{ margin: "6px 0", opacity: 0.8, wordBreak: "break-word" }}>
          {String(error.message || error)}
        </div>
        <button
          type="button"
          onClick={this.reset}
          style={{
            marginTop: "6px",
            padding: "4px 10px",
            borderRadius: "6px",
            border: "1px solid currentColor",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
