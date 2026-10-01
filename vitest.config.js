import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['scripts/**/*.mjs', 'src/**/*.js'],
      // check.mjs는 run()을 호출하는 진입점뿐이라 통합 테스트(별도 프로세스)로 검증한다
      exclude: ['scripts/check.mjs'],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
