import { defineConfig } from 'vitest/config';

// Fixtures with bare clock times ("9am", "Friday") are read in the machine's
// zone. Pin it so the suite gives the same answer on every machine; tests for
// zone-tagged resets ("3am (UTC)") assert on absolute instants instead.
process.env.TZ = 'UTC';

export default defineConfig({
  test: {
    env: { TZ: 'UTC' },
  },
});
