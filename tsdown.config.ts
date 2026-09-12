import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-balance'

// client bundle 运行时只依赖 react：槽位注册走 ctx.slots 结构形态，
// 不引用任何 @deepseek-ai/* client 包（0.1.2-rc.1 已无 dsh-client-runtime）。
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

// 宿主自包含打包：把 @deepseek-ai/dsh-tools / schemastery / cordis 等运行时依赖
// 全部打进 lib/index.js（node: 内置模块保持 external）。官方装配或热装配对
// 目录外 link: 依赖不装 peers，Node 从包真实路径解析不到会整棵 plugin tree
// 加载失败——打包后 lib 零外部依赖，任何装配路径都能加载。
const hostBundle: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    alwaysBundle: (id: string) => !id.startsWith('node:'),
  },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}

export default [hostBundle, clientBundle] satisfies UserConfig[]
