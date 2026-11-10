export interface ShortcutRegistrar {
  register(accelerator: string, run: () => void): boolean;
  unregister(accelerator: string): void;
}

interface Change {
  commit(): void;
  rollback(): void;
}

/** Register a replacement while the last successful binding remains active. */
export class GlobalShortcutBinding {
  private current = '';
  private staged = false;

  constructor(private readonly os: ShortcutRegistrar, private readonly run: () => void) {}

  get active(): string {
    return this.current;
  }

  prepare(accelerator: string): Change | undefined {
    if (this.staged) return undefined;
    if (accelerator === this.current) return { commit() {}, rollback() {} };
    if (accelerator) {
      try {
        if (!this.os.register(accelerator, () => {
          if (this.current === accelerator) this.run();
        })) return undefined;
      } catch {
        return undefined;
      }
    }
    this.staged = true;
    let settled = false;
    const finish = (committed: boolean) => {
      if (settled) return;
      settled = true;
      this.staged = false;
      if (committed) {
        const old = this.current;
        this.current = accelerator;
        if (old) this.os.unregister(old);
      } else if (accelerator) this.os.unregister(accelerator);
    };
    return { commit: () => finish(true), rollback: () => finish(false) };
  }
}
