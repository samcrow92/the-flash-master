import { Component, type ErrorInfo, type ReactNode } from "react";

/** One automatic retry per boundary within this window; a second failure shows the fallback instead of looping. */
export const AUTO_RETRY_MS = 30_000;

interface Props {
  /** Shown in the log and the fallback: which part of the app failed. */
  name: string;
  /** Changing it (e.g. navigating to another view) clears the error and renders the children again. */
  resetKey?: string;
  /** Fill the whole window (the root boundary) instead of the area it wraps. */
  full?: boolean;
  children: ReactNode;
}

/**
 * Without a boundary, React unmounts the whole tree on an uncaught render error and the window is left as an empty
 * frame (a flat gray screen under the glass material). This keeps the error contained to the part that failed, logs
 * it (renderer console errors go to main.log), retries once, and otherwise offers Try again / Reload.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  private lastAuto = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.name}] ${error?.stack ?? error}\n${info.componentStack ?? ""}`);
    const now = Date.now();
    if (now - this.lastAuto > AUTO_RETRY_MS) {
      this.lastAuto = now;
      this.timer = setTimeout(this.reset, 400);
    }
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  override componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }

  reset = () => {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.setState({ error: null });
  };

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`crash-panel${this.props.full ? " full" : ""}`} role="alert">
        <div className="crash-title">Something went wrong in {this.props.name}.</div>
        <div className="crash-detail">{String(error.message || error).slice(0, 300)}</div>
        <div className="crash-actions">
          <button className="primary" onClick={this.reset}>Try again</button>
          <button onClick={() => location.reload()}>Reload window</button>
        </div>
      </div>
    );
  }
}
