import { fileURLToPath } from 'node:url';

/** 仓库绝对路径；让测试入口和临时产物都固定在 workspace 内。 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * 测试只借 Vite 做一件事：把 TypeScript 与 workspace 包打成一个 Node 可执行文件。
 * 断言和测试调度都在 run.ts 内完成，因此仓库不需要额外引入测试框架或 DOM 模拟库。
 */
export default {
  root: projectRoot,
  resolve: {
    alias: {
      react: fileURLToPath(
        new URL('../packages/react/src/index.ts', import.meta.url),
      ),
      'react-reconciler': fileURLToPath(
        new URL('../packages/react-reconciler/src/index.ts', import.meta.url),
      ),
      scheduler: fileURLToPath(
        new URL('../packages/scheduler/src/index.ts', import.meta.url),
      ),
      shared: fileURLToPath(
        new URL('../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  build: {
    emptyOutDir: true,
    outDir: '.test-dist',
    ssr: 'tests/run.ts',
    target: 'esnext',
    rollupOptions: {
      output: {
        entryFileNames: 'run.mjs',
        inlineDynamicImports: true,
      },
    },
  },
  ssr: {
    noExternal: true,
  },
};
