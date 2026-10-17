// Runs `task` after `firstMs`, then `everyMs` after each run ends. Failures are logged on one line.
export function startPolling(opts: { firstMs: number; everyMs: number; label: string; task(): Promise<void> }): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    try {
      await opts.task();
    } catch (error) {
      console.error(`Inbox: ${opts.label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stopped) timer = setTimeout(tick, opts.everyMs);
  };
  timer = setTimeout(tick, opts.firstMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
