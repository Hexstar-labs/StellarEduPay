'use strict';
// Minimal next/link stub for the Jest root environment.
const React = require('react');
function Link({ href, children, ...rest }) {
  return React.createElement('a', { href, ...rest }, children);
}
module.exports = Link;
module.exports.default = Link;
