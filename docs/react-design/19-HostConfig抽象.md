# 第 19 章：HostConfig：让 reconciler 不认识 `document`

[← 返回总目录](../../React设计与实现.md) · [上一章](./18-最小Lane.md) · [下一章 →](./20-DOM属性与简易事件.md)

> 主文件：`packages/react-reconciler/src/HostConfig.ts`、`hostContext.ts`、`packages/react-dom/src/hostConfig.ts`

Fiber 已经算出“这里要新增一个 `div`”，接下来却遇到一个问题：在浏览器里要调用 `document.createElement`，换到别的平台又没有 `document`。调和算法怎样描述同一次挂载，同时不依赖某个平台的 API？答案不是让 reconciler 猜平台，而是由 renderer 注入 HostConfig。

## 本章书签

- [19.1 HostConfig 划出的依赖边界](#191-hostconfig-划出的依赖边界)
- [19.2 能力怎样分组以及 Container 为何独立](#192-能力怎样分组以及-container-为何独立)
- [19.3 一次 mount 如何落到 DOM 以及教学版边界](#193-一次-mount-如何落到-dom-以及教学版边界)
- [面试复习](#面试复习)
- [源码入口](#源码入口)

---

## 19.1 HostConfig 划出的依赖边界

先看一段最小伪代码。reconciler 只表达意图：

```ts
const instance = hostConfig.createInstance('div', props);
hostConfig.appendChildToContainer(container, instance);
```

至于 `instance` 是 `HTMLElement`、测试用普通对象，还是其他平台的节点，由 HostConfig 实现决定。本仓库的依赖方向是：

```text
react-reconciler
  └─ 只依赖 HostConfig 接口
             ▲
             │ 注入实现
react-dom
  └─ hostConfig.ts 才调用 document / DOM 方法
```

因此，`packages/react-reconciler/src` 中的 `completeWork` 与 `commitWork` 不直接引用 `document`。它们可以知道“宿主实例”“文本实例”“根容器”这些抽象角色，却不知道这些对象是否来自浏览器。

这层边界拆开了两类职责：

- reconciler 负责 Fiber 遍历、Diff、flags、Placement、删除顺序和 commit 阶段。
- HostConfig 负责把“创建、插入、删除、更新”翻译成具体平台操作。

HostConfig 不是另一套 Diff 算法。比如 `commitPlacement` 先由 reconciler 找到宿主父节点和稳定兄弟，再决定 append 还是 insert；HostConfig 只执行最后那次平台调用。

本仓库实际只提供 DOM renderer，但接口允许测试 renderer 用普通对象树实现同样能力。官方 React 也通过 HostConfig 支撑不同 renderer，不过其接口更大，注入主要在构建时完成，还覆盖 hydration、persistence 等模式。当前仓库是为了把依赖方向讲清而保留的最小版本。

## 19.2 能力怎样分组，以及 Container 为何独立

`HostConfig` 可以按生命周期分成四组：

| 能力组 | 方法 | 本仓库中的作用 |
| --- | --- | --- |
| 创建 | `createInstance`、`createTextInstance` | complete 阶段创建尚未挂载的元素或文本 |
| 插入 / 移动 | `appendChild`、`appendChildToContainer`、`insertBefore`、`insertInContainerBefore` | 组装离线子树，或在 commit 中插入、移动 |
| 删除 | `removeChild`、`removeChildFromContainer` | commit 删除宿主节点 |
| 更新 | `commitUpdate`、`commitTextUpdate` | commit 修改已有实例的 props 或文本 |

DOM 实现非常直接：

```ts
createInstance(type, props) {
  const instance = document.createElement(type);
  applyProps(instance, props);
  return instance;
}

commitTextUpdate(textInstance, _oldText, newText) {
  textInstance.nodeValue = newText;
}
```

这里第一次出现了 `document`，位置在 `packages/react-dom/src/hostConfig.ts`，不在 reconciler。

### Container 不是普通 Instance

为什么已有 `appendChild`，还需要 `appendChildToContainer`？

在类型上，`HostConfig` 把二者分开：

```text
Container  根 renderer 接管的外部容器，例如传给 createRoot 的 Element
Instance   reconciler 通过 createInstance 创建的宿主节点，例如 div
```

在 Fiber 结构上也不同：

```text
HostRoot.stateNode ──► FiberRoot
                         └─ containerInfo ──► Container

HostComponent.stateNode ──► Instance
```

所以 Placement 找到 `HostRoot` 时，不能把它的 `stateNode` 当作普通宿主父节点。`commitPlacement` 要先取 `FiberRoot.containerInfo`，再调用 `appendChildToContainer` 或 `insertInContainerBefore`；父节点是 `HostComponent` 时，才调用普通 Instance 版本。

DOM 恰好让 Container 和 Instance 都能调用 `appendChild`，容易让人误以为这组区分多余。抽象接口不能依赖这个巧合：其他 renderer 的根容器与普通实例可能类型不同、操作也不同。

还有一个容易越界的能力：**ref 不属于 HostConfig。** `beginWork` 只打 `Ref` flag；commit 的 Layout 阶段由 reconciler 执行 `commitAttachRef`，把宿主 `stateNode` 写给 ref，或调用函数 ref。HostConfig 负责产生宿主实例，却不负责 React ref 的生命周期。

## 19.3 一次 mount 如何落到 DOM，以及教学版边界

以第一次挂载下面的元素为例：

```tsx
root.render(
  <section>
    <span>Hello</span>
  </section>,
);
```

从 renderer 入口到页面出现，调用链只有两段：先在 Render/complete 阶段组装离线子树，再在 Commit 阶段接入容器。

```text
ReactDOM.createRoot(container)
  → createContainer(container, hostConfig)
  → FiberRoot.containerInfo = container
  → FiberRoot.hostConfig = hostConfig

root.render(element)
  → Render / completeWork
      1. createTextInstance('Hello')
      2. createInstance('span', props)
      3. appendChild(span, text)
      4. createInstance('section', props)
      5. appendChild(section, span)
  → Commit / commitPlacement
      6. appendChildToContainer(container, section)
```

步骤 1 到 5 会调用 DOM API 创建节点并组装关系，但整棵 `section` 仍未接入根容器。只有步骤 6 才让它进入当前已提交的宿主树。因此：

```text
createInstance ≠ 挂进根容器
Render 中 appendChild ≠ 页面已经 commit
```

`appendChild` 能同时出现在 Render 和 Commit，是因为调用对象不同：complete 阶段把孩子装进新建的离线 Instance；Placement 遇到已挂载的普通宿主父节点时，也可用它插入或移动。是否修改可见宿主树取决于 parent 当时是否已挂载，不取决于方法名。

更新路径则不重新创建实例。`completeWork` 比较新旧 props 或文本，只打 `Update` flag；Mutation 阶段再调用 `commitUpdate` 或 `commitTextUpdate`。本仓库把首次 props 直接交给 `createInstance → applyProps`，没有实现官方 HostConfig 中更细的 `prepareUpdate`、`finalizeInitialChildren` 等步骤。

### 教学版为何不适合多 root 并发隔离

每个 `FiberRoot` 虽然都保存自己的 `hostConfig`，但工作开始时还会把它写进模块级 `currentHostConfig`，随后 `completeWork` / `commitWork` 通过 `getHostConfig()` 读取。`workLoop.ts` 另有模块级 `currentRoot`，当沿 `return` 找不到 HostRoot 时把它作为兜底；`createContainer` 会让后创建的 root 覆盖这个指针。

```text
FiberRoot.hostConfig ── setHostConfig ──► currentHostConfig
后创建的 FiberRoot ────────────────────► currentRoot
```

这让主流程短而易读，却形成了全局可变状态：

- `currentHostConfig` 假设同一时刻只有一个 root 的 Render/Commit 使用这条调用链；
- `currentRoot` 的兜底只可靠地代表最近创建的 root；
- 多 renderer、多 root 交错或可重入执行时，模块级指针可能代表错误的上下文。

所以应把当前实现描述为**教学版的单 root / 全局状态限制**，而不是通用 renderer 隔离方案。官方 React 不靠运行时切换一个全局 HostConfig 指针来支持 renderer；对应宿主方法会被构建进各自的 reconciler。

## 面试复习

**一句话：** reconciler 负责算出宿主操作，HostConfig 负责执行平台原语；Container 是 renderer 接管的根，不等于 `createInstance` 产生的普通 Instance。

**Q：一次 mount 什么时候真正进入页面？**

A：`completeWork` 先用 `createInstance` 和 `appendChild` 组装离线子树；Commit 的 Placement 再用 `appendChildToContainer` 把顶层宿主节点接入根容器。

**Q：ref 为什么不在 HostConfig？**

A：ref 是 React 的 commit 语义。reconciler 在 Layout 阶段负责清旧 ref、附加新 ref；HostConfig 只提供宿主实例和平台操作。

**Q：本仓库的注入方式有什么限制？**

A：root 虽保存 config，但运行时通过模块级 `currentHostConfig` 读取，`currentRoot` 又是最近 root 的兜底，因此它是便于教学的单 root / 全局状态模型，不具备官方实现的 renderer 与多 root 隔离能力。

### 源码入口

- `packages/react-reconciler/src/HostConfig.ts`：宿主能力接口与 Container / Instance 类型
- `packages/react-reconciler/src/hostContext.ts`：模块级 `currentHostConfig`
- `packages/react-reconciler/src/completeWork.ts`：创建实例、组装离线子树
- `packages/react-reconciler/src/commitWork.ts`：Placement、删除、更新与 Layout ref
- `packages/react-reconciler/src/workLoop.ts`：`currentRoot`、root 上的 HostConfig 注入
- `packages/react-dom/src/hostConfig.ts`：DOM 平台实现

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./18-最小Lane.md) · [下一章 →](./20-DOM属性与简易事件.md)
