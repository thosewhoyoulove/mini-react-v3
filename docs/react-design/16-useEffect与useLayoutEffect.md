# 第 16 章：`useEffect` 与 `useLayoutEffect`

[← 返回总目录](../../React设计与实现.md) · [上一章](./15-useState与更新队列.md) · [下一章 →](./17-Scheduler与时间切片.md)

> 主文件：`packages/react-reconciler/src/hooks.ts`、`commitWork.ts`  
> 正文待写。

## 本章书签

- [16.1 Effect 挂在哪](#161-effect-挂在哪)
- [16.2 deps 没变与变了](#162-deps-没变与变了)
- [16.3 Passive vs Layout](#163-passive-vs-layout)

---

## 16.1 Effect 挂在哪

Hook 的 `memoizedState` 与 Fiber flags

（待写）

## 16.2 deps 没变与变了

没变：跳过；变了：先 destroy 再 create

（待写）

## 16.3 Passive vs Layout

绘制后 vs 绘制前同步

（待写）
