/**
 * What a live run has started and must not leave behind: the agent, the isolated daemon, the fixture windows and
 * browsers, the temp homes. Each is registered when it starts and removed when it is closed the normal way. On Ctrl+C,
 * a kill or a crash, everything still registered is closed, newest first, and the process exits.
 */
type Closer = () => Promise<void> | void;

export class Cleanup {
  private closers: Closer[] = [];
  private running: Promise<void> | null = null;

  /** Register something to close. Returns the function that takes it off the list (call it after closing it yourself). */
  add(close: Closer): () => void {
    this.closers.push(close);
    return () => { this.closers = this.closers.filter(c => c !== close); };
  }

  get pending(): number { return this.closers.length; }

  /** Close everything still registered, newest first. Each closer runs once, gets `perCloserMs`, and may fail. */
  runAll(perCloserMs = 15_000): Promise<void> {
    return this.running ??= (async () => {
      for (const close of this.closers.splice(0).reverse()) {
        try {
          await Promise.race([Promise.resolve().then(close), new Promise<void>(r => { const t = setTimeout(r, perCloserMs); t.unref?.(); })]);
        } catch { /* the next one still runs */ }
      }
      this.running = null;
    })();
  }

  /**
   * Close everything and exit on SIGINT, SIGTERM, SIGHUP, an uncaught exception or an unhandled rejection. A second
   * signal while closing exits at once. Returns the function that removes the handlers.
   */
  install(o: { exit?: (code: number) => void; log?: (line: string) => void; target?: NodeJS.EventEmitter } = {}): () => void {
    const exit = o.exit ?? ((code: number) => process.exit(code));
    const log = o.log ?? ((line: string) => console.error(line));
    const target = o.target ?? process;
    let closing = false;
    const handler = (why: string, code: number) => () => {
      if (closing) { exit(code); return; }
      closing = true;
      log(`\nbench: ${why}: stopping the agent, the daemon and the fixtures (${this.pending} to close) ...`);
      void this.runAll().then(() => exit(code));
    };
    const handlers: Array<[string, () => void]> = [
      ['SIGINT', handler('interrupted (Ctrl+C)', 130)], ['SIGTERM', handler('terminated', 143)], ['SIGHUP', handler('the terminal closed', 129)],
      ['uncaughtException', handler('crashed', 1)], ['unhandledRejection', handler('crashed', 1)],
    ];
    for (const [event, h] of handlers) target.on(event, h);
    return () => { for (const [event, h] of handlers) target.off(event, h); };
  }
}
