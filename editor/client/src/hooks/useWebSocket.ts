import { useEffect, useRef, useState } from 'react';

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface UseWebSocketOptions {
  /** Full WebSocket URL, e.g. ws://localhost:3100/api/ws?projectId=demo */
  url: string | null;
  /** Called on every incoming message. */
  onMessage: (data: unknown) => void;
  /** Called when (re)connected. */
  onConnected?: () => void;
}

const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 15_000;
const BACKOFF_FACTOR = 1.5;

/**
 * Manages a WebSocket connection with automatic exponential-backoff reconnect.
 */
export function useWebSocket({ url, onMessage, onConnected }: UseWebSocketOptions) {
  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const retryDelayRef = useRef(INITIAL_RETRY_MS);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  // Keep callbacks in refs to avoid re-triggering the effect
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => {
    unmountedRef.current = false;

    if (!url) {
      setStatus('disconnected');
      return;
    }

    function connect() {
      if (unmountedRef.current || !url) return;

      setStatus('connecting');

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmountedRef.current) { ws.close(); return; }
        setStatus('connected');
        retryDelayRef.current = INITIAL_RETRY_MS;
        onConnectedRef.current?.();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          onMessageRef.current(data);
        } catch {
          // Ignore non-JSON messages
        }
      };

      ws.onerror = () => {
        if (unmountedRef.current) return;
        setStatus('error');
      };

      ws.onclose = () => {
        if (unmountedRef.current) return;
        setStatus('disconnected');
        wsRef.current = null;

        // Schedule reconnect with exponential backoff
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * BACKOFF_FACTOR, MAX_RETRY_MS);
        retryTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      unmountedRef.current = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [url]);

  return { status };
}
