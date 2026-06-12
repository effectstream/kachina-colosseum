import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteCommonjs } from "@originjs/vite-plugin-commonjs";
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wsBrowserPath = path.join(path.dirname(require.resolve('ws/package.json')), 'browser.js');
const cryptoShimPath = path.resolve(import.meta.dirname!, 'src/shims/crypto.ts');
const levelShimPath = path.resolve(import.meta.dirname!, 'src/shims/level.ts');
const utilInspectShimPath = path.resolve(import.meta.dirname!, 'src/shims/util.inspect.cjs');
const managedDir = path.resolve(import.meta.dirname!, '../contract/src/managed/pvp');
const publicDir = path.resolve(import.meta.dirname!, 'public');

function artifactMiddleware(req: any, res: any, next: any) {
  const url: string = (req.url ?? '').split('?')[0];
  let filePath: string | null = null;
  let rootDir: string | null = null;

  if (url.startsWith('/keys/')) {
    rootDir = path.resolve(managedDir, 'keys');
    filePath = path.resolve(rootDir, url.slice('/keys/'.length));
  } else if (url.startsWith('/zkir/')) {
    rootDir = path.resolve(managedDir, 'zkir');
    filePath = path.resolve(rootDir, url.slice('/zkir/'.length));
  } else if (url.startsWith('/midnight-prover/')) {
    rootDir = path.resolve(publicDir, 'midnight-prover');
    filePath = path.resolve(rootDir, url.slice('/midnight-prover/'.length));
  }

  if (!filePath || !rootDir) {
    next();
    return;
  }

  const rel = path.relative(rootDir, filePath);
  if (rel.startsWith('..') || rel === '') {
    res.statusCode = 400;
    res.end('Invalid ZK artifact path');
    return;
  }

  if (existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    createReadStream(filePath).pipe(res);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(`ZK artifact not found: ${url}`);
}

function serveContractArtifacts() {
  return {
    name: 'serve-contract-artifacts',
    configureServer(server: any) {
      server.middlewares.use(artifactMiddleware);
    },
    configurePreviewServer(server: any) {
      server.middlewares.use(artifactMiddleware);
    },
  };
}

// https://github.com/vitejs/vite/blob/ec7ee22cf15bed05a6c55693ecbac27cfd615118/packages/vite/src/node/plugins/workerImportMetaUrl.ts#L127-L128
const workerImportMetaUrlRE =
  /\bnew\s+(?:Worker|SharedWorker)\s*\(\s*(new\s+URL\s*\(\s*('[^']+'|"[^"]+"|`[^`]+`)\s*,\s*import\.meta\.url\s*\))/g;

// Source maps + Sentry upload only when .env.sentry-build-plugin exists
const sentryEnabled = existsSync('.env.sentry-build-plugin');

// https://vitejs.dev/config/
export default defineConfig({
  cacheDir: "./.vite",
  build: {
    target: "esnext",
    minify: false,
    sourcemap: sentryEnabled ? "hidden" : false,
    commonjsOptions: {
      transformMixedEsModules: true,
      extensions: ['.js', '.cjs'],
      ignoreDynamicRequires: true,
    },
  },
  plugins: [
    {
      name: 'object-inspect-util-shim',
      enforce: 'pre',
      resolveId(source, importer) {
        if (
          (source === './util.inspect' || source.endsWith('/object-inspect/util.inspect')) &&
          importer?.includes('object-inspect')
        ) {
          return utilInspectShimPath;
        }
      },
      transform(code, id) {
        if (id.includes('object-inspect/util.inspect')) {
          return {
            code: readFileSync(utilInspectShimPath, 'utf8'),
            map: null,
          };
        }
        if (
          id.includes('object-inspect') &&
          id.endsWith('/index.js') &&
          code.includes('utilInspect.custom')
        ) {
          return {
            code: code.replace(
              /var inspectCustom = utilInspect\.custom;/,
              "var inspectCustom = Symbol.for('nodejs.util.inspect.custom');",
            ),
            map: null,
          };
        }
      },
    },
    // crypto-browserify lacks timingSafeEqual. Patch the level-private-state-provider
    // dist directly: strip it from the crypto import and inject an inline implementation.
    {
      name: 'patch-crypto-timingsafeequal',
      enforce: 'pre',
      transform(code: string, id: string) {
        if (!id.includes('@midnight-ntwrk/midnight-js-level-private-state-provider')) return;
        if (!code.includes('timingSafeEqual')) return;
        const patched = code
          .replace(/,\s*timingSafeEqual(?=[,\s}])/g, '')
          .replace(/timingSafeEqual\s*,\s*/g, '');
        return {
          code: patched + '\nfunction timingSafeEqual(a, b) { if (a.length !== b.length) return false; var r = 0; for (var i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; }\n',
          map: null,
        };
      },
    },
    wasm(),
    topLevelAwait(),
    react(),
    serveContractArtifacts(),
    viteCommonjs(),
    nodePolyfills({
      include: [
        'buffer',
        'process',
        'crypto',
        'path',
        'fs',
        'assert',
        'stream',
        'util',
        'events',
      ],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
    // Sentry source maps upload — only when .env.sentry-build-plugin is present
    sentryEnabled && sentryVitePlugin({
      org: "midnight-foundation",
      project: "pvp",
    }),
  ],
  optimizeDeps: {
    include: [
      'object-inspect',
      'fp-ts',
      'fp-ts/function',
      'rxjs',
      'isomorphic-ws',
    ],
    exclude: [
      '@midnight-ntwrk/midnight-js-level-private-state-provider',
      '@paima/midnight-wasm-prover',
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/ledger-v8',
    ],
    esbuildOptions: {
      target: "esnext",
      define: {
        global: 'globalThis',
      },
    },
  },
  resolve: {
    dedupe: [
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/midnight-js-contracts',
    ],
    alias: {
      crypto: cryptoShimPath,
      'node:crypto': cryptoShimPath,
      level: levelShimPath,
      'isomorphic-ws': wsBrowserPath,
    },
  },
  define: {
    global: 'globalThis',
  },
  assetsInclude: ['**/*.bin'],
  worker: {
    format: "es",
    plugins: () => [
      wasm(),
      topLevelAwait(),
    ],
    rollupOptions: {
      output: {
        chunkFileNames: "assets/worker/[name]-[hash].js",
        assetFileNames: "assets/worker/[name]-[hash][extname]",
      },
    },
  },
  server: {
    fs: {
      strict: false,
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
