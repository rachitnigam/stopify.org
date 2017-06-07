import { yieldStopify } from './stopifyImplementation/stopifyYield'
import { cpsStopify } from './stopifyImplementation/stopifyCPSEval'
import { trampolinedCpsStopify } from './stopifyImplementation/stopifyCPSTrampoline'
import { regeneratorStopify } from './stopifyImplementation/stopifyRegenerator'
import { StopWrapper } from './helpers'
import * as fs from 'fs'
import * as path from 'path'

function showUsage() {
  console.log('Usage: stopify.js -i <filename> -t [cps|tcps|yield|regen] [options]');
  console.log('       stopify.js -s <string> -t [cps|tcps|yield|regen] [options]\n');
  console.log('Options:')
  console.log('  -y, --interval     Set yield interval')
  console.log('  -o, --output       Can be print, eval, benchmark')
  process.exit(0);
}

const argv = require('minimist')(process.argv.slice(2));
if (argv.h || argv.help) {
  showUsage();
}
let code;
if (argv.s) {
  code = argv.s;
} else if (argv.file || argv.i) {
  const filename = argv.file || argv.i
  code = fs.readFileSync(
    path.join(process.cwd(), filename), 'utf-8').toString()
} else {
  console.log('No input')
  showUsage();
}

const transform = argv.transform || argv.t
const output = argv.output || argv.o || 'print';

if (transform === undefined) {
  console.log('No transformation was specified')
  showUsage();
}

let stopifyFunc;
const sw: StopWrapper = new StopWrapper();
switch(transform) {
  case 'yield':
    stopifyFunc = yieldStopify
    break;
  case 'cps':
    stopifyFunc = cpsStopify
    break;
  case 'tcps':
    stopifyFunc = trampolinedCpsStopify
    break;
  case 'regen':
    stopifyFunc = regeneratorStopify
    break;
  default:
    throw new Error(`Unknown transform: ${transform}`)
}

const compileStart = process.hrtime();
const stoppable = stopifyFunc(code, sw.isStop, sw.stop)
const compileEnd = process.hrtime(compileStart);
const compileTime = (compileEnd[0] * 1e9 + compileEnd[1]) * 1e-9

const yieldInterval = argv.y || argv.yieldInterval
if (yieldInterval !== undefined) {
  let interval = parseInt(argv.y || argv.yieldInterval)
  if (isNaN(interval)) throw new Error(`Unknown interval: ${yieldInterval}`)
  stoppable.setInterval(interval);
}

switch(output) {
  case 'print': {
    console.log(stoppable.transformed)
    console.log(`// Compilation time: ${compileTime}s`)
    break;
  }
  case 'eval': {
    const runStart = process.hrtime();
    stoppable.run(() => {
      console.log(`Compilation time: ${compileTime}s`)
      const runEnd = process.hrtime(runStart);
      console.log(`Runtime: ${(runEnd[0] * 1e9 + runEnd[1]) * 1e-9}s`)
    })
    break;
  }
  case 'benchmark': {
    const runStart = process.hrtime();
    stoppable.run(() => {
      const runEnd = process.hrtime(runStart);
      process.stdout.write(`${(runEnd[0] * 1e9 + runEnd[1]) * 1e-9}`)
    })
    break;
  }
  default:
    console.log(`Unknown output format: ${output}`)
    console.log(stoppable.transformed)
    console.log(`// Compilation time: ${compileTime}s`)
    break;
}