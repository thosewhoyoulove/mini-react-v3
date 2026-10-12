# mini-react

一个用于学习 React 核心更新链路的 TypeScript 教学实现。仓库采用接近 React 官方源码的包边界和命名，但只保留适合逐步讲解的主干能力。

它的目标不是替代 React，而是让下面这条路径能够运行、单步阅读并用测试验证：

```text
createElement / JSX
  → ReactElement
  → Fiber 调和与双缓冲
  → beginWork 向下 / completeWork 向上
  → Flags 记录副作用
  → Commit 修改 DOM、执行 Effect
```

## 已实现能力

- ReactElement、`createElement`、`jsx-runtime`
- 函数组件与 Fiber 的 `child / sibling / return` 链表
- current / work-in-progress 双缓冲
- 单节点与 keyed 数组 Diff，包括复用、插入、移动和删除
- Render / Commit 两阶段以及 Mutation / Layout / Passive 顺序
- `useState`、环形更新队列和同档更新合并调度
- `useEffect`、`useLayoutEffect` 及依赖比较
- `SyncLane` / `DefaultLane` 两档优先级
- `MessageChannel` 宏任务与固定 5ms 时间切片
- HostConfig 宿主抽象、DOM 属性更新和简单 `onXxx` 事件

完整 React 尚未实现的能力和教学版差异，见[复习附录](./docs/react-design/appendix.md#教学实现与官方-react-的差异)。尤其要注意：这里没有完整 Lane rebase、`beginWork` bailout、合成事件、Context、Suspense、SSR 等能力。

## 包结构

```text
packages/shared            公共类型、符号和特性开关
packages/scheduler         MessageChannel 调度与时间切片
packages/react             createElement、JSX runtime、Hooks 公共 API
packages/react-reconciler  Fiber、Diff、Hooks、Render、Commit、Lane
packages/react-dom         DOM HostConfig 与 createRoot
demos/hello-dom            可交互教学实验
tests                      不依赖浏览器的内存宿主行为测试
```

依赖方向为：

```text
shared ← react / scheduler ← react-reconciler ← react-dom
```

内部包使用 `workspace:*` 连接。

## 运行

需要 Node.js 18+ 和 pnpm 9。

```bash
pnpm install
pnpm dev
```

打开 Vite 输出的本地地址。页面按主题拆成三个实验：

1. State：单次更新与连续三个函数式更新
2. Keyed Diff：追加、反转、删除首项
3. Effect：观察 Layout / Passive 的 create 与 cleanup 顺序

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build:demo
```

`pnpm test` 会把 TypeScript 测试和 workspace 源码打成一个临时 Node 程序，再使用内存 HostConfig 验证 Fiber 与 Commit 行为。测试产物写入 `.test-dist/`，不会提交到仓库。

当前测试覆盖：

- ReactElement 的 key/ref 拆分与 children 规范化
- 相同 type 的宿主节点与文本复用
- keyed 列表移动和删除
- 多个函数式 `setState` 的入队顺序与合并调度
- Layout / Passive Effect 的更新与卸载时序
- DOM 属性、布尔属性和事件监听器更新

## 在手机上读讲稿

同一 Wi-Fi 下执行 `pnpm docs:dev`，用手机浏览器打开终端里的 Network 地址。侧栏是全书目录，章节底部可以上一章、下一章。

推送到 `main`，并在仓库 Settings → Pages 里把来源选成 GitHub Actions 之后，也可以打开 <https://thosewhoyoulove.github.io/mini-react-v3/>。

## 学习路径

- 系统学习：从 [React设计与实现.md](./React设计与实现.md) 的 21 章目录开始
- 面试复习：先读 [INTERVIEW.md](./INTERVIEW.md) 的 3 分钟主线
- 行为验证：一边操作 `demos/hello-dom`，一边运行 `pnpm test`
- 边界校准：用[附录](./docs/react-design/appendix.md)区分教学实现和官方 React

阅读源码时建议始终追问四件事：入口在哪里、Fiber 数据怎样变化、为什么这样设计、教学版省略了什么。
