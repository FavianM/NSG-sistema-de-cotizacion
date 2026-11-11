module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/servidor.js',
    '!**/node_modules/**',
  ],
  testMatch: [
    '**/pruebas/**/*.test.js',
    '**/pruebas/**/*.spec.js',
    '**/src/__tests__/**/*.test.js',
    '**/src/__tests__/**/*.spec.js',
  ],
  coverageThreshold: {
    global: {
      branches: 75,
      functions: 85,
      lines: 80,
      statements: 80,
    },
  },
  setupFilesAfterEnv: ['<rootDir>/pruebas/setup.js'],
  testTimeout: 30000,
  // Correr tests en serie para evitar interferencia entre suites que comparten BD
  maxWorkers: 1,
};
