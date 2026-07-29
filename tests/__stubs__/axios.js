'use strict';
// Minimal axios stub for the Jest root environment, where axios is not
// installed.  Tests that import components which transitively require axios
// (e.g. api.js) should mock the api module entirely; this stub prevents the
// resolver from failing on the bare import before the mock takes effect.
const axios = {
  create: () => axios,
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
  interceptors: {
    request:  { use: jest.fn() },
    response: { use: jest.fn() },
  },
  defaults: { headers: { common: {} } },
};
module.exports = axios;
module.exports.default = axios;
