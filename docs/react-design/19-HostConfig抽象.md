# 第 19 章：HostConfig：让 reconciler 不认识 `document`

[← 返回总目录](../../React设计与实现.md) · [上一章](./18-最小Lane.md) · [下一章 →](./20-DOM属性与简易事件.md)

> 主文件：`packages/react-reconciler/src/HostConfig.ts`、`hostContext.ts`、`packages/react-dom/src/hostConfig.ts`

Fiber 已经算出“这里要新增一个 `div`”，浏览器接下来会调用 `document.createElement`。可调和器若直接依赖 `document`，同一套 Fiber 工作流程就只能服务于 DOM。这里需要一层转换：reconciler 描述要做的宿主操作，renderer 注入 HostConfig，把这些操作翻译成平台 API。

## 19.1 HostConfig 划出的依赖边界

reconciler 里的宿主操作可以缩成两句伪代码：

```ts
const instance = hostConfig.createInstance('div', props);
hostConfig.appendChildToContainer(container, instance);
```

第一句要求创建一个宿主实例，第二句要求把它接入根容器。这里没有规定 `instance` 必须是 `HTMLElement`；测试 renderer 可以返回普通对象，其他平台也可以返回自己的节点。具体类型和操作都由传入的 HostConfig 决定。

```text
react-reconciler
  └─ 只依赖 HostConfig 接口
             ▲
             │ 注入实现
react-dom
  └─ hostConfig.ts 才调用 document / DOM 方法
```

沿着这个依赖方向，`completeWork` 和 `commitWork` 只认识“宿主实例”“文本实例”“根容器”等角色。Fiber 遍历、Diff、flags、Placement、删除顺序和 commit 时机仍由 reconciler 掌握；创建、插入、删除和更新节点时，它再调用 HostConfig。

HostConfig 并不负责重新做一次 Diff。以 `commitPlacement` 为例，稳定兄弟节点和宿主父节点已经由 reconciler 找好，append 还是 insert 也已经确定。HostConfig 接到的任务，只是执行最后一次平台操作。本项目虽然只实现了 DOM renderer，这层接口仍把平台代码留在了 `packages/react-dom`。

## 19.2 能力怎样分组，以及 Container 为何独立

`HostConfig` 提供的操作贯穿宿主节点的一生。`createInstance` 和 `createTextInstance` 在 complete 阶段创建节点；`appendChild`、`insertBefore` 及其 Container 版本负责组装或放置节点；`removeChild` 负责删除；`commitUpdate`、`commitTextUpdate` 则修改已经存在的实例。

DOM 版本把这些抽象落实为熟悉的浏览器 API：

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

`document` 到这里才出现。创建元素时还会写入首批 props；文本更新发生在 commit 中，直接改已有文本节点的 `nodeValue`。两条路径都没有反过来介入 Fiber 的比较过程。

接口还特意区分了 `Container` 和 `Instance`。Container 是 renderer 接管的外部根容器，例如传给 `createRoot` 的元素；Instance 是 reconciler 通过 `createInstance` 创建的普通宿主节点，例如一个 `div`。二者在 Fiber 上也通向不同位置：

```text
HostRoot.stateNode ──► FiberRoot
                         └─ containerInfo ──► Container

HostComponent.stateNode ──► Instance
```

Placement 找到 `HostRoot` 时，要从 `FiberRoot.containerInfo` 取得容器，调用 `appendChildToContainer` 或 `insertInContainerBefore`。父节点若是 `HostComponent`，才使用接收普通 Instance 的版本。DOM 的根容器和普通元素碰巧都有 `appendChild`，但 HostConfig 的类型不能依赖这一平台特征。

ref 走的是另一条提交路径。`beginWork` 发现 ref 变化后打上 `Ref` flag，Layout 阶段再由 reconciler 执行 `commitAttachRef`，把宿主 `stateNode` 交给函数 ref 或对象 ref。HostConfig 产出宿主实例，却不接管 React ref 的生命周期。

## 19.3 一次 mount 如何落到 DOM，以及教学版边界

把下面的元素第一次交给 root：

```tsx
root.render(
  <section>
    <span>Hello</span>
  </section>,
);
```

DOM 节点会经历“离线组装”和“接入容器”两个阶段：

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

前五步已经调用 DOM API，也已经把 `span` 和文本接到 `section` 下，但 `section` 尚未进入根容器。第六步执行后，这棵宿主子树才成为已提交 DOM 的一部分。由此也能理解为什么 `appendChild` 既可能出现在 Render，又可能出现在 Commit：关键在于 parent 是否已经挂载，而不只是方法名。

更新已有节点时，`completeWork` 比较新旧 props 或文本并打 `Update` flag，Mutation 阶段随后调用 `commitUpdate` 或 `commitTextUpdate`。首次 props 则在 `createInstance → applyProps` 中直接写入。本项目没有展开官方 HostConfig 中的 `prepareUpdate`、`finalizeInitialChildren` 等步骤，这些接口也不影响这里的主线。

还有一项与运行上下文有关的限制。每个 `FiberRoot` 保存自己的 `hostConfig`，开始工作时却会把它写入模块级 `currentHostConfig`，`completeWork` 和 `commitWork` 再通过 `getHostConfig()` 读取。`workLoop.ts` 里的模块级 `currentRoot` 还会在沿 `return` 找不到 HostRoot 时充当兜底，后创建的 root 会覆盖这个指针。

```text
FiberRoot.hostConfig ── setHostConfig ──► currentHostConfig
后创建的 FiberRoot ────────────────────► currentRoot
```

这些共享指针让单 root 的调用链很短；一旦多个 root 或多个 renderer 交错、重入执行，指针便可能落在另一个上下文。本项目展示的是单 root 下的 HostConfig 注入流程，并未提供完整的多 root 并发隔离。官方 React 的宿主方法会构建进各自的 reconciler，不依靠运行时切换这样一个全局 HostConfig 指针。

## 本章回顾

- reconciler 决定做什么以及何时做，HostConfig 把最终的宿主操作交给具体平台。
- mount 时先在 complete 阶段组装离线宿主树，再由 Commit 的 Placement 把顶层节点接入 Container。
- Container 与普通 Instance 在 Fiber 上的来源不同；ref 也属于 reconciler 的 commit 语义，不是 HostConfig 的属性操作。
- 模块级 `currentHostConfig` 和 `currentRoot` 使这套实现适合讲解单 root 流程，却不足以隔离交错执行的多个 root。

### 源码入口

- `packages/react-reconciler/src/HostConfig.ts`：宿主能力接口与 Container / Instance 类型
- `packages/react-reconciler/src/hostContext.ts`：模块级 `currentHostConfig`
- `packages/react-reconciler/src/completeWork.ts`：创建实例、组装离线子树
- `packages/react-reconciler/src/commitWork.ts`：Placement、删除、更新与 Layout ref
- `packages/react-reconciler/src/workLoop.ts`：`currentRoot`、root 上的 HostConfig 注入
- `packages/react-dom/src/hostConfig.ts`：DOM 平台实现

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./18-最小Lane.md) · [下一章 →](./20-DOM属性与简易事件.md)
