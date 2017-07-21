'use strict';

import {
  yieldStopify, yieldStopifyPrint
} from './yield/stopifyYield'
import {
  regenStopify, regenStopifyPrint
} from './yield/stopifyRegen'
import {
  cpsStopify, cpsStopifyPrint
} from './cps/stopifyCps'
import {
  callCCStopify, callCCStopifyPrint
} from './callcc/stopifyCallCC'
import {
  tcpsStopify, tcpsStopifyPrint
} from './cps/stopifyTCps'
import { stopifyPrint } from './interfaces/stopifyInterface'
import { StopWrapper, Options } from './common/helpers'
import * as fs from 'fs'
import * as path from 'path'

const program = require('commander');

program
  .usage('Usage: stopify -i <file> -t <transform> [options] ')
  .option('-i, --input <filename>', 'The input file', readFile)
  .option('-t, --transform <transform>', 'The stopify transform', readTransform)
  .option('-o, --output', 'Specify output mode', readOutputMode)
  .option('-y, --interval <n>', 'Set the yield interval', parseInt)
  .option('-d, --debug', 'Enable debugging')
  .option('--optimize', 'Enable optimization pass')
  .option('--tailcalls', 'Enable tailcalls (for generator based transform)')
  .option('--no-eval', 'Assume safe eval')
  .option('--benchmark', 'Output benchmarking information')
  .parse(process.argv)


function readFile(f: string): string {
  const code = fs.readFileSync(path.join(process.cwd(), f), 'utf-8').toString();
  if(!code) {
    throw new Error(`Failed to read from ${f}`)
  } else {
    return code;
  }
}

function readTransform(str: string): string {
  const validTransforms = ['cps', 'tcps', 'callcc', 'yield', 'regen'];
  if(validTransforms.includes(str)) {
    return str;
  } else {
    throw new Error(`${str} is not a valid transform.` +
      ` Specify one of ${validTransforms.join(', ')}`)
  }
}

function readOutputMode(s: string): string {
  const outputModes = ['print', 'eval', 'stop', 'html'];
  if(outputModes.includes(s)) {
    return s
  } else {
    throw new Error(`${s} is not a valid output mode` +
      `. Specify one of ${outputModes.join(', ')}`)
  }
}

const code: string = program.input;
const transform: string = program.transform;
const output: string = program.ouput || 'print';
const interval: number = program.interval;
const benchmark: boolean = program.benchmark || false;

let opts: Options = {
  debug: program.debug,
  optimize: program.optimize,
  no_eval: program.noEval,
  tail_calls: program.tailcalls,
}

function timeInSecs(time: number[]): string {
  return `${time[0] + time[1] * 1e-9}`
}

let stopifyFunc: stopifyPrint;
switch(transform) {
  case 'yield':
    stopifyFunc = yieldStopifyPrint
    break;
  case 'regen':
    stopifyFunc = regenStopifyPrint
    break;
  case 'cps':
    stopifyFunc = cpsStopifyPrint
    break;
  case 'tcps':
    stopifyFunc = tcpsStopifyPrint
    break;
  case 'callcc':
    stopifyFunc = callCCStopifyPrint
    break;
  default:
    throw new Error(`Unknown transform: ${transform}`)
}
const stime = Date.now()
const prog = stopifyFunc(code, opts)
const ctime = (Date.now() - stime)
let runnableProg;
if (benchmark) {
  const latencyMeasure =
`
let $$oldDate = Date.now();
const $$measurements = [];
const $$internalSetTimeout = (global || window).setTimeout;
let setTimeout = function (f, t) {
  const $$currDate = Date.now();
  $$measurements.push($$currDate - $$oldDate);
  $$oldDate = $$currDate
  $$internalSetTimeout(f, t);
}`
  const benchmarkingData = `
console.log("Options: " + JSON.stringify(${JSON.stringify(opts)}));
const $$ml = $$measurements.length
const $$latencyAvg = $$measurements.reduce((x, y) => x + y)/$$ml;
const $$latencyVar = $$measurements.map(x => Math.pow(x - $$latencyAvg, 2))
                                   .reduce((x, y) => x + y)/$$ml;
console.log("Latency measurements: " + $$ml +
            ", avg: " + $$latencyAvg +
            "ms, var: " + $$latencyVar + "ms");
`
  runnableProg =
`
${latencyMeasure}
const s = Date.now();
(${prog}).call(this, _ => false, () => 0, () => {
  const e = Date.now();
  console.log("Runtime: " + (e - s) + "ms");
  ${benchmarkingData}
}, |INTERVAL|
    ${interval})`
} else {
  runnableProg =
`
const s = Date.now();
(${prog}).call(this, _ => false, () => 0, () => {
  const e = Date.now();
  console.log("Runtime: " + (e - s) + "ms");
}, |INTERVAL|
    ${interval})`
}

console.log(`// Compilation time: ${ctime}ms`)

switch(output) {
  case 'html': {
    const html = `<html><body><script>${runnableProg}</script></body></html>`
    console.log(html)
    break;
  }
  case 'print': {
    console.log(runnableProg)
    break;
  }
  case 'eval': {
    eval(runnableProg)
    break;
  }
  case 'stop': {
    let stopifyFunc;
    switch(transform) {
      case 'yield':
        stopifyFunc = yieldStopify;
        break;
      case 'regen':
        stopifyFunc = regenStopify;
        break;
      case 'cps':
        stopifyFunc = cpsStopify;
        break;
      case 'tcps':
        stopifyFunc = tcpsStopify;
        break;
      case 'callcc':
        stopifyFunc = callCCStopify;
        break;
      default:
        throw new Error(`Unknown transform: ${transform}`)
    }
    let ctime = "";
    let prog;
    const stime = process.hrtime()
    prog = stopifyFunc(code, opts)
    ctime = timeInSecs(process.hrtime(stime))
    console.log(`// Compilation time: ${ctime}s`)
    const sw: StopWrapper = new StopWrapper();
    let rtime = "";
    if (process) {
      const stime = process.hrtime()
      prog(sw.isStop.bind(sw), () =>{
        const rtime = process.hrtime(stime)
        console.log(`// Stop time: ${timeInSecs(rtime)}`)
      }, () => {}, interval)
      setTimeout(_ => {
        sw.stop()
      }, 1000)
    }
    break;
  }
  default:
    throw new Error(`Unknown output format: ${output}`)
    break;
}
