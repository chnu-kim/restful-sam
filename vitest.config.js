import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['worker/**/*.js', 'src/**/*.js'],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
