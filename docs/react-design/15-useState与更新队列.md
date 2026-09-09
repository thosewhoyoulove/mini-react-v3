# 第 15 章：`useState` 与更新队列

[← 返回总目录](../../React设计与实现.md) · [上一章](./14-Hook链表与Dispatcher.md) · [下一章 →](./16-useEffect与useLayoutEffect.md)

> 主文件：`packages/react-reconciler/src/hooks.ts`、`scheduleUpdate.ts`  
> 正文待写。

## 本章书签

- [15.1 一格 Hook 里存什么](#151-一格-hook-里存什么)
- [15.2 环形 pending 队列](#152-环形-pending-队列)
- [15.3 调度一次更新](#153-调度一次更新)

---

## 15.1 一格 Hook 里存什么

`memoizedState` / `queue`

（待写）

## 15.2 环形 pending 队列

setState 先入队，下次 render 再算

（待写）

## 15.3 调度一次更新

从 Fiber 往上标 lanes，进工作循环

（待写）
