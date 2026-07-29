'use strict';
// Minimal next/router stub for the Jest root environment.
const useRouter = jest.fn(() => ({
  pathname: '/',
  route: '/',
  query: {},
  asPath: '/',
  push: jest.fn(),
  replace: jest.fn(),
  reload: jest.fn(),
  back: jest.fn(),
  prefetch: jest.fn(),
  beforePopState: jest.fn(),
  events: { on: jest.fn(), off: jest.fn(), emit: jest.fn() },
  isFallback: false,
}));
module.exports = { useRouter, default: { useRouter } };
