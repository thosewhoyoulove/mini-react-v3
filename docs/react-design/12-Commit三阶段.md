# 第 12 章：Commit：Mutation / Layout / Passive

[← 返回总目录](../../React设计与实现.md) · [上一章](./11-completeWork.md) · [下一章 →](./13-函数组件的执行时机.md)

> 主文件：`packages/react-reconciler/src/commitWork.ts`  
> 正文待写。

## 本章书签

- [12.1 Mutation](#121-mutation)
- [12.2 切换 `root.current`](#122-切换-rootcurrent)
- [12.3 Layout](#123-layout)
- [12.4 Passive](#124-passive)

---

## 12.1 Mutation

删、插、改，真正碰 document

（待写）

## 12.2 切换 `root.current`

`root.current = finishedWork`

（待写）

## 12.3 Layout

同步跑 `useLayoutEffect` 的 destroy / create

（待写）

## 12.4 Passive

绘制后再跑 `useEffect`（宏任务）

（待写）
