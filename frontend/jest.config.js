/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // Match every __tests__/*.test.js file under src/
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.[jt]s?(x)'],
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', { presets: [['@babel/preset-env', { targets: { node: 'current' } }]] }],
  },
};
