# 附录

[← 返回总目录](../../React设计与实现.md) · [上一章](./21-createRoot与updateContainer.md)

## 本书书签

- [附录 A：与 `INTERVIEW.md` 六节对照](#附录-a与-interviewmd-六节对照)
- [附录 B：用 `demos/hello-dom` 验证的路径](#附录-b用-demoshello-dom-验证的路径)
- [附录 C：本书不写（仓库未实现）](#附录-c本书不写仓库未实现)

---

## 附录 A：与 `INTERVIEW.md` 六节对照

| 面试节 | 本书对应章 |
| --- | --- |
| JSX / createElement | [第 4](./04-ReactElement与createElement.md)、[第 5](./05-JSX与jsx-runtime与typeof.md) 章 |
| Fiber | [第 6](./06-Fiber链表与双缓冲.md)、[第 7](./07-副作用标记Flags.md) 章 |
| Render vs Commit | [第 8](./08-工作循环.md)～[第 12](./12-Commit三阶段.md) 章 |
| Diff | [第 10](./10-子节点Diff.md) 章 |
| Hooks | [第 13](./13-函数组件的执行时机.md)～[第 16](./16-useEffect与useLayoutEffect.md) 章 |
| Scheduler | [第 17](./17-Scheduler与时间切片.md)、[第 18](./18-最小Lane.md) 章 |

## 附录 B：用 `demos/hello-dom` 验证的路径

- setState 触发 DefaultLane 更新（计数）
- 带 key 的列表 reverse：移动而非重新挂载
- `useEffect`：title 随状态更新，cleanup 在下次 effect 前执行

## 附录 C：本书不写（仓库未实现）

- Fragment / Portal / Context / Suspense / lazy / memo / forwardRef
- Class 组件 / Error Boundary
- `useRef` / `useMemo` / `useCallback` / `useReducer` / `useTransition` 等
- 合成事件与根节点委托
- 完整 Lane 档位、`beginWork` bailout、Scheduler 优先堆
- SSR / hydrate、`flushSync` / `startTransition`
