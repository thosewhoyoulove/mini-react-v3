# 第 14 章：Hook 链表与 mount / update 两套 Dispatcher

[← 返回总目录](../../React设计与实现.md) · [上一章](./13-函数组件的执行时机.md) · [下一章 →](./15-useState与更新队列.md)

> 主文件：`packages/react-reconciler/src/hooks.ts`、`packages/react/src/ReactHooks.ts`、`ReactCurrentDispatcher.ts`  
> 正文待写。

## 本章书签

- [14.1 Hook 链表挂在哪](#141-hook-链表挂在哪)
- [14.2 游标怎么挪](#142-游标怎么挪)
- [14.3 mount 与 update](#143-mount-与-update)
- [14.4 Dispatcher](#144-dispatcher)

---

## 14.1 Hook 链表挂在哪

`fiber.memoizedState` → Hook0 → Hook1 → …

（待写）

## 14.2 游标怎么挪

`workInProgressHook` / `currentHook`

（待写）

## 14.3 mount 与 update

mount 往后接新格，update 顺着 current 克隆到 wip

（待写）

## 14.4 Dispatcher

对外 API 只读 Dispatcher，真正实现在 reconciler

（待写）
