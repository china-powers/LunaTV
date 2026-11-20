// eslint-disable-next-line @typescript-eslint/no-var-requires
const nextJest = require('next/jest');

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: './',
});

// Add any custom config to be passed to Jest
const customJestConfig = {
  // Add more setup options before each test is run
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],

  // if using TypeScript with a baseUrl set to the root directory then you need the below for alias' to work
  moduleDirectories: ['node_modules', '<rootDir>/'],

  testEnvironment: 'jest-environment-jsdom',

  // pnpm 的符号链接目录里存在同名包的多个版本，jest-haste-map 会因此报
  // Haste module naming collision 并拒绝启动。测试都在 src 下，把扫描范围
  // 收窄到 src 并容忍重复模块即可，第三方包仍走正常的 node 解析
  roots: ['<rootDir>/src'],
  haste: { throwOnModuleCollision: false },
  modulePathIgnorePatterns: ['<rootDir>/node_modules/.pnpm/'],

  /**
   * Absolute imports and Module Path Aliases
   */
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^~/(.*)$': '<rootDir>/public/$1',
    '^.+\\.(svg)$': '<rootDir>/src/__mocks__/svg.tsx',
  },
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
module.exports = createJestConfig(customJestConfig);
