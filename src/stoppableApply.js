/**
 * Plugin to transform function applications into `apply` calls and define
 * `apply` at the top-level as stoppable.
 */

const t = require('babel-types');
const b = require('babylon');

const visitor = {};

const applyFunction = b.parse(`
let iterations = 0;
let counter = iterations;
function apply(f, k, ...args) {
  if (counter-- === 0) {
    counter = iterations;
    window.setTimeout(_ => {
      if (window.stopped) {
        console.log('terminated execution');
      } else {
        return f(k, ...args);
      }
    }, 0);
  } else {
    return f(k, ...args);
  }
}
`);

visitor.Program = {
  exit(path) {
    path.node.body.unshift(applyFunction);
  },
};

visitor.CallExpression = function (path) {
  const applyId = t.identifier('apply');
  const applyArgs = [path.node.callee, ...path.node.arguments];
  const applyCall = t.callExpression(applyId, applyArgs);
  path.node.callee = applyId;
  path.node.arguments = applyArgs;
};

module.exports = function transform(babel) {
  return { visitor };
};
