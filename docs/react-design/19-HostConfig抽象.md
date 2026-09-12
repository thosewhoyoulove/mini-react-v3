# 第 19 章：HostConfig 抽象

[← 返回总目录](../../React设计与实现.md) · [上一章](./18-最小Lane.md) · [下一章 →](./20-DOM属性与简易事件.md)

> 主文件：`packages/react-reconciler/src/HostConfig.ts`、`hostContext.ts`、`packages/react-dom/src/hostConfig.ts`
> 调和器只描述「要创建 / 插入 / 删除 / 改属性」，不写死 `document`。宿主能力通过接口注入。

## 本章书签

- [19.1 reconciler 为什么不能直接写 DOM API](#191-reconciler-为什么不能直接写-dom-api)
- [19.2 注入的能力清单](#192-注入的能力清单)
- [19.3 换一套 host config](#193-换一套-host-config)
- [19.4 reconciler → HostConfig → DOM 调用链](#194-reconciler--hostconfig--dom-调用链)
- [面试复习](#面试复习)

---

## 19.1 reconciler 为什么不能直接写 DOM API

`completeWork` 和 `commitWork` 若直接 `document.createElement`，会破坏第 3 章的依赖方向：

- reconciler 将依赖浏览器全局，测试环境、非 DOM 宿主都跑不起来。
- 官方同一套调和器能接 `react-dom`、`react-native`、测试渲染器，靠的就是这层接口。
- 教学上「Render 不碰文档树」也会糊：`createInstance` 出现在 reconciler 里，读者分不清「new 节点」和「挂进 #root」。

本仓库的做法：

```text
createContainer(container, hostConfig)  把 config 存进 FiberRoot
setHostConfig(hostConfig)               模块级指针，本轮工作循环可取
completeWork / commitWork               只调 getHostConfig().xxx
```

`hostContext.ts` 只有 `set` / `get`。`document` 全部留在 `packages/react-dom/src/hostConfig.ts`。

## 19.2 注入的能力清单

`HostConfig` 接口按「创建 → 挂到树上 → 更新 → 删除」分组：

| 方法 | 谁调用 | 含义 |
| --- | --- | --- |
| `createInstance` | `completeWork` 首次 HostComponent | 按 type / props 造宿主节点 |
| `createTextInstance` | `completeWork` 首次 HostText | 造文本节点 |
| `appendChild` | `completeWork.appendAllChildren`、普通父节点插入 | 孩子挂到已有父实例 |
| `appendChildToContainer` | Commit Placement，父是 HostRoot | 挂到 `#root` |
| `insertBefore` | Placement 有宿主兄弟锚点 | 插到参照节点前 |
| `insertInContainerBefore` | 同上，父是容器 | 容器版 insertBefore |
| `removeChild` / `removeChildFromContainer` | Commit 删除 | 从父或容器摘掉 |
| `commitUpdate` | Mutation，Host 带 Update | 新旧 props 打到实例上 |
| `commitTextUpdate` | Mutation，文本带 Update | 改 `nodeValue` |

容器和普通父节点分成两套方法，因为 HostRoot 的 `stateNode` 是 `FiberRoot`，真正的 DOM 在 `containerInfo`。调和器先判断 `parentFiber.tag === HostRoot`，再选 `*ToContainer` / `*InContainerBefore`。

本仓库没有 `finalizeInitialChildren`、`prepareUpdate`、`hideInstance` 等官方细项。首次属性在 `createInstance` 里一次性 `applyProps`；更新走 `commitUpdate`。

## 19.3 换一套 host config

理论上，实现同一份接口就能换宿主：

```text
DOM config      → HTMLElement / Text，本仓库已实现
测试 config     → 普通对象树，断言 children / props
终端 / Canvas   → 自己的「实例」与「插入」
```

教学版只接 DOM。不要在 reconciler 里为了 demo 偷写 `document`——那会让第 2 章「宿主无关」变成空话。

## 19.4 reconciler → HostConfig → DOM 调用链

HostConfig 不是另一套调和算法，而是 reconciler 到具体平台的最后一跳。以 DOM renderer 为例：

```text
首次创建 HostComponent
completeWork
  → getHostConfig().createInstance('div', props)
  → packages/react-dom/src/hostConfig.ts
  → document.createElement('div') + applyProps

组装离线宿主子树
completeWork.appendAllChildren
  → getHostConfig().appendChild(parent, child)
  → parent.appendChild(child)

挂入根容器
commitWork.commitPlacement
  → getHostConfig().appendChildToContainer(container, child)
  → container.appendChild(child)

更新属性
commitWork
  → getHostConfig().commitUpdate(instance, type, oldProps, newProps)
  → applyProps(instance, newProps, oldProps)
```

其中最关键的边界是：

```text
createInstance ≠ 挂入文档树
```

`document.createElement` 只创建一个独立节点；`appendAllChildren` 也只是把独立节点组装成离线子树。只有 Commit 的 Placement 调 `appendChildToContainer`、`insertInContainerBefore`，或向已经挂载的 HostComponent 调 `appendChild` / `insertBefore`，节点才进入当前已提交的宿主树。

这里也解释了为什么 `appendChild` 同时会出现在 Render 和 Commit：

- Render/complete 中，parent 是刚创建、尚未挂载的 Host 实例，用于离线组装；
- Commit 中，parent 是容器或已挂载 Host 实例，用于真正插入或移动。

下一章看 DOM 这一套 config 具体怎么处理 `className`、`style`、布尔属性和 `onXxx`。

---

## 面试复习

### 一句话结论

reconciler 负责算出要做什么，HostConfig 把“创建、插入、删除、更新”翻译成平台操作；创建宿主实例不等于把它挂入文档树。

### 面试回答（可口述，为什么→机制→仓库落点→官方差异）

为什么抽 HostConfig：Fiber 调和与调度不应绑定浏览器，否则同一套 reconciler 无法服务其他宿主。机制上，root 保存 renderer 注入的 config，工作循环设置当前 config，`completeWork` 调创建与离线 append，`commitWork` 调插入、删除和更新。仓库接口在 `react-reconciler/src/HostConfig.ts`，DOM 实现在 `react-dom/src/hostConfig.ts`。官方 React 使用构建期注入并有更完整的 mutation/persistence/hydration 能力；本仓库用 FiberRoot 保存 config 加模块级指针，适合教学但不适合多 root 并发隔离。

### 常见追问

**Q：`document.createElement` 算不算修改 DOM？**
A：它创建 DOM 对象，但没有修改页面中的已挂载文档树；可见树变化发生在插入容器或已挂载父节点时。

**Q：为什么容器版 API 要单独命名？**
A：HostRoot 的 `stateNode` 是 FiberRoot，不是普通宿主实例；真实容器在 `containerInfo`，类型和操作入口需要区分。

**Q：同一个 `appendChild` 为什么 Render 和 Commit 都会调用？**
A：complete 阶段用于离线组装新实例；Commit 阶段用于向已挂载 Host 父节点插入或移动。

### 容易说错

- 错：HostConfig 负责 Diff。对：Diff 在 reconciler，HostConfig 只执行平台原语。
- 错：`createInstance` 后节点已进入 `#root`。对：进入已提交树要等 Placement。
- 错：reconciler 完全不知道容器。对：它知道抽象 Container/Instance，但不知道 DOM API 细节。

### 源码入口

- `packages/react-reconciler/src/HostConfig.ts`
- `packages/react-reconciler/src/hostContext.ts`
- `packages/react-reconciler/src/completeWork.ts`
- `packages/react-reconciler/src/commitWork.ts`
- `packages/react-dom/src/hostConfig.ts`

[← 返回总目录](../../React设计与实现.md) · [上一章](./18-最小Lane.md) · [下一章 →](./20-DOM属性与简易事件.md)
