import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  label: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <div className="max-w-sm text-center">
            <div className="mb-1 text-[12px] font-semibold text-[color:var(--danger)]">
              {this.props.label} crashed
            </div>
            <div className="mb-3 font-mono text-[10px] text-[color:var(--text-subtle)]">
              {this.state.error.message}
            </div>
            <button
              type="button"
              className="rounded border border-white/[0.1] bg-white/[0.04] px-3 py-1 text-[11px] text-[color:var(--text-muted)] transition hover:bg-white/[0.08]"
              onClick={() => this.setState({ error: null })}
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
