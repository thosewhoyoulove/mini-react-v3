# 第 20 章：DOM 属性更新与简易 `onXxx` 事件

[← 返回总目录](../../React设计与实现.md) · [上一章](./19-HostConfig抽象.md) · [下一章 →](./21-createRoot与updateContainer.md)

> 主文件：`packages/react-dom/src/hostConfig.ts`
> 调和器只通知「这个实例的 props 变了」。怎么映射到 `class`、style、监听器，是 DOM host config 的事。

## 本章书签

- [20.1 属性更新](#201-属性更新)
- [20.2 简易 `onXxx`](#202-简易-onxxx)
- [20.3 与官方事件委托的差异](#203-与官方事件委托的差异)
- [面试复习](#面试复习)

---

## 20.1 属性更新

`applyProps(dom, nextProps, prevProps?)` 分两趟：

**先清掉「旧有、新无」的键**（更新时）：

- `children` / `key` / `ref` 跳过（不进 DOM 属性）。
- 事件 → `removeEventListener`。
- `className` → 去掉 `class`。
- `style` → 去掉 `style` 属性。
- 其余 → `removeAttribute`。

**再写入新 props：**

| 情况 | 行为 |
| --- | --- |
| `className` | `setAttribute('class', …)` |
| `style` 为对象 | `Object.assign(dom.style, value)` |
| `onXxx` 函数 | 见下一节 |
| `null` / `false` | `removeAttribute`（布尔属性关掉） |
| `true` | `setAttribute(key, '')`（如 `disabled`） |
| 其它 | `setAttribute(key, String(value))` |

`createInstance` 时没有 `prevProps`，只走写入。`commitUpdate` 传入新旧 props，才能卸掉按钮上已经不存在的 `onClick` 或 `className`。

`children` 不在这里处理：文本孩子是独立的 HostText Fiber，由 Diff + `commitTextUpdate` 改 `nodeValue`。若把 `children` 写成 DOM 属性，会和 Fiber 树打成两套真相。

`style` 的教学实现是浅层 `Object.assign`，不会逐个清掉「新 style 里没有的旧键」。完整做法要 diff style 对象；本仓库点到即可。

## 20.2 简易 `onXxx`

约定：props 名以 `on` 开头且长度 ≥ 3，后面转小写当事件名。

```text
onClick  → click
onInput  → input
onChange → change
```

监听器记在 `WeakMap<HTMLElement, Map<eventName, listener>>` 里。`setListener`：

1. 这个元素这个事件若已有旧监听，先 `removeEventListener`。
2. 新值是函数 → `addEventListener` 并记进 Map。
3. 新值不是函数 / 属性被删 → 只卸不挂。

demo 按钮的 `onClick={() => setCount(v => v + 1)}` 每次 Render 都是新函数。`completeWork` 的 `propsNeedUpdate` 用 `Object.is` 比 props，引用不同就会打 `Update`，Commit 再换一次监听。行为正确，只是每次点击更新都会卸挂一次——教学上可接受。

## 20.3 与官方事件委托的差异

官方把多数事件委托到根容器，再按事件插件系统构造合成事件，统一浏览器差异，并沿 React/Fiber 语义收集捕获与冒泡监听。现代 React 已不再池化 SyntheticEvent，`e.persist()` 主要是兼容保留，并不是合成事件机制的核心。

本仓库**不委托**：每个节点自己 `addEventListener`。差异可以摊开：

| | 本仓库 | 官方 |
| --- | --- | --- |
| 绑定位置 | 每个 DOM 节点 | 根容器委托 |
| 事件对象 | 浏览器原生 `Event` | 合成事件 |
| 名称 | `onClick` → `click` | 另有 `onChange` 等特殊映射 |
| 冒泡 | 浏览器默认 | 沿 Fiber 树模拟 |

够支撑 demo 中 State、Keyed Diff、Effect 三组按钮。被问到合成事件时，承认未实现即可（附录 C）。不要在 host config 里半套委托——那会和「简易 onXxx」这条讲解线缠在一起。

下一章把应用入口收束：`createRoot` 如何建出 HostRoot，`render` 如何走进同一套工作循环。

## 面试复习

### 一句话结论

本仓库由每个 DOM 节点直接注册原生事件，更新时卸旧挂新；官方 React 主要在根容器委托事件，再沿 Fiber 收集监听并派发 SyntheticEvent。

### 面试回答（为什么→机制→仓库落点→官方差异）

为什么：教学版只需让 `onClick` 等 demo 工作，逐节点监听最直观；生产 React 需要统一事件语义、降低大量节点的绑定管理成本，并支持 React 树上的捕获/冒泡。机制：本仓库把 `onXxx` 机械转小写，用 WeakMap 保存真实 listener，props 更新时先 `removeEventListener` 再 `addEventListener`。仓库落点：`hostConfig.ts` 的 `eventNameFromProp`、`setListener`、`applyProps`。官方差异：官方有根容器委托、事件插件、SyntheticEvent、优先级与特殊事件映射；本仓库交给浏览器原生冒泡，不沿 Fiber 模拟，也不支持完整 capture 和 `onChange` 语义。

### 常见追问

**Q：本仓库算不算合成事件？**
A：不算。回调收到浏览器原生 `Event`，没有 SyntheticEvent 包装与插件派发。

**Q：父子节点的 `onClick` 如何冒泡？**
A：两个节点各自注册原生 `click` listener，顺序由浏览器 DOM 冒泡决定，不是 React 沿 Fiber 路径模拟。

**Q：为什么每次 render 可能重新绑定？**
A：内联函数引用改变会让 Host props 判定更新；`setListener` 无条件卸掉该事件旧函数，再挂新函数。

**Q：`onChange` 是否具备官方 React 的统一语义？**
A：不具备。本仓库只把它转成原生 `change`；官方会按元素与浏览器走专门事件映射。

### 容易说错

- 不要说本仓库用了根节点事件委托；它是逐 DOM 节点绑定。
- 不要说回调参数是 React SyntheticEvent；这里是原生 Event。
- 不要把所有官方事件都绝对化为根委托；应说「多数事件」，部分事件有特殊处理。
- 不要把 `e.persist()` 当现代合成事件的关键能力；React 17 起事件已不再池化。

### 源码入口

- `packages/react-dom/src/hostConfig.ts`：`eventNameFromProp`
- `packages/react-dom/src/hostConfig.ts`：`setListener`
- `packages/react-dom/src/hostConfig.ts`：`applyProps`
- `packages/react-reconciler/src/commitWork.ts`：`commitWork`（Host 更新进入 `commitUpdate`）

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./19-HostConfig抽象.md) · [下一章 →](./21-createRoot与updateContainer.md)
