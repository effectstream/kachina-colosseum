import { Buffer } from 'buffer';

// Browser polyfills must be set before any dependency (e.g. crypto-browserify /
// readable-stream) reads from `process` or `Buffer`.
if (!globalThis.process) {
  // @ts-expect-error partial process stub for browser libraries
  globalThis.process = {};
}

const proc = globalThis.process as NodeJS.Process & {
  browser?: boolean;
  version?: string;
};

proc.env = {
  ...proc.env,
  NODE_ENV: import.meta.env.MODE,
};
if (!proc.version) {
  proc.version = 'v18.0.0';
}
if (proc.browser === undefined) {
  proc.browser = true;
}

globalThis.Buffer = Buffer;
