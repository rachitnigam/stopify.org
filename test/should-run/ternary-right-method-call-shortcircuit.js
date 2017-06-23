const assert = require('assert')

let x = 0;
function foo() {
  x++;
  return {
    bar() {
      x++;
    }
  }
}

false ? foo().bar() : false;

assert.equal(x,0)