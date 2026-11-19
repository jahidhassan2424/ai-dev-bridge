export type LiveConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline";

export interface LiveEvent {
  id?: string;
  event?: string;
  data: { type?: string; [key: string]: unknown };
}

export function reconnectDelay(attempt: number): number {
  return Math.min(15_000, 1_000 * (2 ** Math.max(0, Math.min(attempt, 4))));
}

export class SseParser {
  private buffer = "";

  push(chunk: string): LiveEvent[] {
    this.buffer += chunk.replaceAll("\r\n", "\n");
    const events: LiveEvent[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      boundary = this.buffer.indexOf("\n\n");
      if (!frame || frame.startsWith(":")) continue;
      let id: string | undefined;
      let event: string | undefined;
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) id = line.slice(3).trimStart();
        else if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      try {
        const parsed = JSON.parse(data.join("\n"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) events.push({ id, event, data: parsed });
      } catch { /* Malformed event data is ignored; authoritative reconciliation remains available. */ }
    }
    return events;
  }
}

interface LiveEventClientOptions {
  url: string;
  token: () => string;
  onEvent: (event: LiveEvent) => void;
  onStatus: (status: LiveConnectionStatus, retryInMs?: number) => void;
  onConnected: () => void;
  fetchImpl?: typeof fetch;
  staleAfterMs?: number;
  watchdogIntervalMs?: number;
}

export class LiveEventClient {
  private running = false;
  private controller?: AbortController;
  private retryTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private finishWait?: () => void;
  private readonly seenIds = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private readonly staleAfterMs: number;
  private readonly watchdogIntervalMs: number;

  constructor(private readonly options: LiveEventClientOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.staleAfterMs = options.staleAfterMs || 45_000;
    this.watchdogIntervalMs = options.watchdogIntervalMs || 5_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.finishWait?.();
    this.retryTimer = undefined;
    this.watchdog = undefined;
    this.finishWait = undefined;
  }

  private wait(delay: number): Promise<void> {
    return new Promise((resolve) => {
      this.finishWait = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.finishWait = undefined;
        resolve();
      }, delay);
    });
  }

  private async run(): Promise<void> {
    let attempt = 0;
    this.options.onStatus("connecting");
    while (this.running) {
      this.controller = new AbortController();
      let staleConnection = false;
      let watchdog: NodeJS.Timeout | undefined;
      try {
        const response = await this.fetchImpl(this.options.url, {
          headers: { Authorization: `Bearer ${this.options.token()}`, Accept: "text/event-stream" },
          cache: "no-store",
          signal: this.controller.signal,
        });
        if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
          throw new Error(`Live event stream returned HTTP ${response.status}.`);
        }
        attempt = 0;
        // Event IDs are process-local. A restarted bridge may legitimately reuse them.
        this.seenIds.clear();
        this.options.onStatus("connected");
        this.options.onConnected();
        const parser = new SseParser();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let lastActivityAt = Date.now();
        watchdog = setInterval(() => {
          if (Date.now() - lastActivityAt <= this.staleAfterMs) return;
          staleConnection = true;
          this.controller?.abort();
        }, this.watchdogIntervalMs);
        this.watchdog = watchdog;
        while (this.running) {
          const result = await reader.read();
          if (result.done) throw new Error("Live event stream ended.");
          // Server heartbeats are SSE comments, so any byte received proves this stream is alive.
          lastActivityAt = Date.now();
          for (const event of parser.push(decoder.decode(result.value, { stream: true }))) {
            if (event.id && this.seenIds.has(event.id)) continue;
            if (event.id) {
              this.seenIds.add(event.id);
              if (this.seenIds.size > 200) this.seenIds.delete(this.seenIds.values().next().value!);
            }
            this.options.onEvent(event);
          }
        }
      } catch (error) {
        if (watchdog) {
          clearInterval(watchdog);
          if (this.watchdog === watchdog) this.watchdog = undefined;
        }
        if (!this.running || ((error instanceof Error && error.name === "AbortError") && !staleConnection)) break;
        const delay = reconnectDelay(attempt++);
        this.options.onStatus(attempt === 1 ? "offline" : "reconnecting", delay);
        await this.wait(delay);
      } finally {
        if (watchdog) clearInterval(watchdog);
        if (this.watchdog === watchdog) this.watchdog = undefined;
      }
    }
  }
}
