import { defineConfig } from 'vitest/config';

export default defineConfig({
  // git worktree and process-spawning tests can exceed the 5 s default on a loaded machine.
  test: { testTimeout: 20_000 },
});
