/**
 * Client 面 bundle 构建（自包含，复刻 @deepseek-ai/dsh-client 官方 tsdown 机制）。
 *
 * 产物 lib/client.js 是一个闭包工厂：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports; } })
 * 浏览器端的 DSH Loader 用其 module table 里的 require 解析外部依赖，因此：
 *   - 运行时真正用到的模块（react/react-jsx 与 @deepseek-ai/dsh-client-ui-primitives）
 *     一律标为 deps.neverBundle（external），由 Loader 的 require 提供；
 *   - 本包 client 源码从 runtime/ui-slots/layout 的 import 全是 type-only，
 *     编译后被擦除，不会进运行时 bundle。
 *
 * 参考：~/deepseek-harness/packages/client/tsdown.client.ts 的 banner/intro/footer 与
 * PLATFORM_MODULES。本包 client 源码未用 CSS Module，故不需要 css inline plugin。
 */
import { defineConfig } from 'tsdown'

const ID = '@linjianyu/dsh-web-ui-enhance'

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: './src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  // 由浏览器 Loader module table 提供的运行时模块（external，不内联）。
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-runtime/client',
    ],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
