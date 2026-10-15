# 第 14 章：Hook 链表与 Dispatcher

[← 返回总目录](../../React设计与实现.md) · [上一章](./13-函数组件的执行时机.md) · [下一章 →](./15-useState与更新队列.md)

同一个组件每次执行，都会重新走一遍 `useState`、`useRef` 和 `useEffect`。这些调用没有 key，局部变量名也不会留到下一轮。React 要找回每个 Hook 的数据，靠的是调用顺序、Fiber 上的单向链表，以及渲染期间临时启用的 Dispatcher。

> 源码入口：`packages/react-reconciler/src/hooks.ts`、`packages/react/src/ReactHooks.ts`、`packages/react/src/ReactCurrentDispatcher.ts`

## 14.1 调用顺序就是 Hook 的身份

```tsx
function Profile() {
  const [name, setName] = useState('Ada');    // 第 1 次 Hook 调用
  const inputRef = useRef(null);              // 第 2 次 Hook 调用
  useEffect(() => console.log(name), [name]); // 第 3 次 Hook 调用
  return <input ref={inputRef} value={name} />;
}
```

组件执行时，`name` 和 `inputRef` 只是局部变量。Fiber 真正保存的是一条按调用次序排列的 Hook 链：

```text
fiber.memoizedState
        │
        ▼
      Hook0 ──next──► Hook1 ──next──► Hook2 ──next──► null
      useState       useRef           useEffect
```

下一次执行 `Profile`，第一次 Hook 调用读取旧链第一格，第二次读取第二格，依次向后。各种 Hook 共用这条链，不会先找一条 state 链，再找另一条 effect 链。调用位置就是它们跨 render 对齐时的身份。

把某次调用放进条件分支，位置就可能变化：

```tsx
function Profile({ editable }) {
  const [name] = useState('Ada'); // 第 1 格
  if (editable) {
    useRef(null);                 // 有时出现的第 2 格
  }
  useEffect(() => {}, []);        // 可能从第 3 格滑到第 2 格
}
```

`editable` 从 `true` 变为 `false` 后，本轮第二次调用已经是 `useEffect`，旧链第二格却保存着 `useRef` 的数据。链表只知道位置，无法根据 API 名称把它送回第三格。本实现会检查“本轮 Hook 更多”的情况，但对 Hook 变少和类型变化的检查不如官方 React 开发构建完整；即使暂时没有报错，错位本身仍然存在。

链上每一格都有 `memoizedState`、`queue`、`baseQueue` 和 `next` 这些字段，不过不同 Hook 使用字段的方式不同。`useState` 把状态放在 `memoizedState`，并用 `queue` 保存更新；`useRef` 在 `memoizedState` 中保存稳定的 `{ current }` 对象；`useMemo` 和 `useCallback` 分别保存 `[计算结果, deps]` 与 `[函数, deps]`。`useEffect`、`useLayoutEffect` 也占一格，其中记录 `{ tag, create, destroy, deps }`。

`useContext` 是这里的例外。它同样通过 Dispatcher 进入 `readContext`，却不调用 `mountWorkInProgressHook` 或 `updateWorkInProgressHook`，所以不占普通 Hook 格。读取到的 `{ context, memoizedValue }` 会接到 `fiber.dependencies`，供 bailout 前检查 Context 是否变化；每次 `renderWithHooks` 开始时，这份依赖会清空并重新收集。

Effect 的提交结构也有一处需要单独留意：本实现直接遍历 Hook 链处理 effect，官方 React 还会把 effect 组织进函数组件的 effect 队列。两者都有 Hook 链，但不能据此认为内部结构完全相同。

## 14.2 mount 新建链，update 对齐旧链

首次 render 没有旧链可读。组件每调用一次 Hook，`mountWorkInProgressHook` 就创建一个节点，并把它接在链尾：

```text
第一次调用：fiber.memoizedState = Hook0
第二次调用：Hook0.next = Hook1
第三次调用：Hook1.next = Hook2
```

`workInProgressHook` 始终指向刚接好的节点。随后，`mountState`、`mountRef` 或 `mountEffect` 再把各自的数据写进去：链表操作决定“这是第几格”，具体 Hook 实现决定“这一格保存什么”。

更新 render 不能直接改动已经提交的 current 链。`updateWorkInProgressHook` 一边读取旧节点，一边为 WIP 创建副本：

```text
current Fiber:  old0 ─► old1 ─► old2
                   │       │       │
                   ▼       ▼       ▼
wip Fiber:      new0 ─► new1 ─► new2
```

这里有三个配合移动的指针：`currentlyRenderingFiber` 指向正在执行的函数组件 WIP Fiber，`currentHook` 记录旧链读到哪里，`workInProgressHook` 记录新链刚接到哪里。第一次 Hook 调用从 `currentlyRenderingFiber.alternate.memoizedState` 取得旧链表头，后面的调用沿 `currentHook.next` 前进。

每读到一格，代码会复制它的 `memoizedState`、`baseQueue` 和 `queue`，再把新节点接到 WIP 链尾。Hook 节点本身是新的，状态 Hook 的 `queue` 对象却继续复用，这也是原来的 `setState` 函数可以保持身份稳定的原因。

在组件开始执行前，`renderWithHooks` 已把 `workInProgress.memoizedState` 清空，本轮 WIP 链会从头构造。假如 render 中断并被放弃，这条半成品链可以随 WIP 一起丢掉；下一次仍从已提交的 current 链重新读取。

回到 `Profile`，第一次 `useState` 克隆 `old0`，随后处理它的更新队列；`useRef` 克隆 `old1`，取出其中同一个 ref 对象；`useEffect` 克隆 `old2`，再比较新旧 deps。组件返回时，新链已经完整挂在 WIP Fiber 上，等 commit 后接替 current。

## 14.3 Dispatcher 划定 Hook 的执行边界

应用从 `react` 包调用的 `useState` 并不认识 Fiber。公开 API 只把参数交给当时生效的 Dispatcher：

```ts
export function useState(initialState) {
  return resolveDispatcher().useState(initialState);
}
```

Dispatcher 是一张 Hook 函数表。首次 render 使用的表把 API 指向 mount 实现，更新时使用的表则指向 update 实现：

```ts
HooksDispatcherOnMount = {
  useState: mountState,
  useRef: mountRef,
  useEffect: mountEffect,
  // ...
};

HooksDispatcherOnUpdate = {
  useState: updateState,
  useRef: updateRef,
  useEffect: updateEffect,
  // ...
};
```

`renderWithHooks` 查看 current 是否已有普通 Hook 链，选择其中一张表，然后才执行 `Component(props)`。组件源码里的同一句 `useState(0)`，第一次会新建节点，更新时会读取旧链的对应节点。

```text
renderWithHooks
  → 设置 currentlyRenderingFiber 与链表游标
  → ReactCurrentDispatcher.current = mount 或 update 表
  → 执行 Component(props)
  → finally 中清空 Dispatcher 和游标
```

清理工作放在 `finally` 中，即使组件抛错也会执行。组件 render 之外没有可用的 Dispatcher，也没有正在处理的 Fiber，此时调用 Hook 就会得到非法调用错误。Dispatcher 只负责把公开 Hook API 分派到本轮实现；它不负责选择任务优先级，那是调度路径的工作。

本实现通过 `current == null || current.memoizedState == null` 选择 mount。只调用 `useContext` 的组件没有普通 Hook 链，更新时仍会选 mount 表，不过两张表的 `useContext` 都指向 `readContext`，结果不受影响。官方 React 还有重渲染、开发期检查和 render phase update 等 Dispatcher，这里的两张表只是本项目涉及的路径。

下一章继续沿着 `useState` 节点里的 `queue` 往下走，看看 `setState` 放进去的 action 如何在下一轮 render 中变成新状态。

## 本章回顾

- Fiber 用一条单向 Hook 链保存组件状态，本轮第 N 次 Hook 调用与旧链第 N 格对齐。
- mount 会逐格创建链表；update 会复制旧节点，同时复用状态 Hook 的 `queue`。
- Dispatcher 让同一个公开 API 在首次 render 和更新 render 中进入不同实现，并把 Hook 调用限制在组件执行期间。
- `useContext` 经由 Dispatcher 读取值，但依赖记录在 `fiber.dependencies`，不占普通 Hook 格。

源码阅读可以围绕 `hooks.ts` 中的 `mountWorkInProgressHook`、`updateWorkInProgressHook`、`renderWithHooks` 和 `readContext` 展开，再回到 `ReactHooks.ts` 查看 `resolveDispatcher`。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./13-函数组件的执行时机.md) · [下一章 →](./15-useState与更新队列.md)
