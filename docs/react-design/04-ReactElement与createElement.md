# 第 4 章：ReactElement 与 `createElement`

[← 返回总目录](../../React设计与实现.md) · [上一章](./03-mini-react包结构与依赖方向.md) · [下一章 →](./05-JSX与jsx-runtime与typeof.md)

> 主文件：`packages/react/src/ReactElement.ts`、`packages/shared/src/ReactTypes.ts`
> Element 是声明式的第一层产物：普通对象，不是 DOM，也不是 Fiber。

## 本章书签

- [4.1 Element 是数据，不是 DOM](#41-element-是数据不是-dom)
- [4.2 `type` / `key` / `props` 各自管什么](#42-type--key--props-各自管什么)
- [4.3 从 props 里拆出 `key` 与 `ref`](#43-从-props-里拆出-key-与-ref)
- [面试复习](#面试复习)

---

## 4.1 Element 是数据，不是 DOM

`createElement` 的返回值是一个普通对象，类型在 `shared` 里：

```ts
export interface ReactElement {
  $$typeof: symbol | number;
  type: Type;
  key: Key;
  ref: Ref;
  props: Props;
}
```

demo 里写：

```ts
createElement('button', { onClick: () => setCount((v) => v + 1) }, '+1');
```

得到的大致是：

```ts
{
  $$typeof: Symbol.for('react.element'),
  type: 'button',
  key: null,
  ref: null,
  props: { onClick: fn, children: '+1' },
}
```

这里没有 `HTMLButtonElement`。浏览器节点要等 `completeWork` 调 `hostConfig.createInstance` 才出现。把 Element 和 DOM 当成同一种东西，后面就讲不清「为什么 Render 可以中断」：中断的是对数据的遍历，不是对已经挂上屏幕的节点动手脚。

调和器认 Element 靠 `$$typeof === REACT_ELEMENT_TYPE`，不靠 `constructor`（见 `childFiber.ts` 的 `isReactElement`）。为什么必须是 Symbol，下一章展开。

函数组件同样是 Element，只是 `type` 换成函数：

```ts
createElement(App, null);
// type: App 函数本身，props: {}
```

`beginWork` 看到 `typeof type === 'function'` 才会去跑 `App(props)`。在那之前，它和 `<div>` 一样，只是树上的一个描述节点。

## 4.2 `type` / `key` / `props` 各自管什么

三个字段在后续阶段分工不同，不要混：

| 字段 | 是什么 | 谁用 |
| --- | --- | --- |
| `type` | 「这是什么」。字符串 → 宿主标签；函数 → 函数组件 | `createFiberFromElement` 定 tag；Diff 判断能不能复用 |
| `key` | 列表里「这是哪一个」 | 第 10 章：和 type 成对，决定复用还是重建 |
| `props` | 这次描述的属性与孩子 | 函数组件当参数；Host 节点当 DOM 属性 / `children` |

`ref` 本仓库从 config 里拆出来了，但没有完整的 `useRef` / commit 写 ref。字段留着是为了对齐官方 Element 形状，读源码时不要当成已实现能力。

`props.children` 的形态决定 Diff 走哪条路：

```text
单个字符串 / 数字  → 单文本
单个 ReactElement  → 单元素
数组               → 列表（先按下标，再按 key 做 Map）
```

`createElement` 自己会把第三参数及以后收进 `children`：一个孩子直接赋值，多个收成数组。

## 4.3 从 props 里拆出 `key` 与 `ref`

调用方常把 `key`、`ref` 和普通属性写在同一个对象里：

```ts
createElement('li', { key: item, className: 'row' }, item);
```

若原样塞进 `props`，组件里就能读到 `props.key`，官方明确禁止这一点：`key` / `ref` 是给调和器用的，不是给业务 props 的。所以 `createElement` 先拆再拷：

1. `config.key !== undefined` → 转成字符串，写成 Element.key。
2. `config.ref !== undefined` → 写成 Element.ref。
3. 其余自有属性拷进 `props`，**跳过** `key` 和 `ref`。
4. 其余参数收成 `props.children`。

```ts
// packages/react/src/ReactElement.ts（结构）
if (hasValidKey(config)) key = '' + config.key;
if (hasValidRef(config)) ref = config.ref;
for (const propName in config) {
  if (propName !== 'key' && propName !== 'ref') {
    props[propName] = config[propName];
  }
}
```

拆完之后，`key` 只活在 Element / Fiber 上；`props` 里不再有它。列表 Diff 读的是 `element.key`，不是 `element.props.key`。

下一章补另外半条入口：打包器把 JSX 编成 `jsx()` 而不是 `createElement()`，以及 `$$typeof` 为什么必须是 Symbol。

## 面试复习

### 一句话结论

ReactElement 是一次 UI 描述的不可执行数据，其中 `type` 表示种类、`key` 表示同层身份、`props` 携带输入；它既不是 Fiber，也不是 DOM。

### 面试回答

为什么不从 Element 直接得到 DOM？因为函数组件、列表身份和更新优先级都需要先经过调和，Element 只负责表达「想要什么」。它的数据结构是 `{$$typeof, type, key, ref, props}`：`createElement` 从 config 中提取 `key/ref`，把普通属性和 children 放进 props；随后 `createFiberFromElement` 根据 type 创建 Fiber，工作循环处理 Fiber，`completeWork` 才创建宿主实例。本仓库的 `ref` 只保留字段形状，没有完整提交语义；官方开发环境的 Element 还有 owner、调试字段、冻结与告警等细节，因此不能把这里的五个字段当成所有版本的完整内部结构。

### 常见追问

**1. Element 与 Fiber 为什么要分开？**

Element 是用户每次 render 产生的描述；Fiber 是 reconciler 可复用、可挂状态和副作用、可暂停遍历的工作节点，两者生命周期和职责不同。

**2. `key` 为什么不在 `props` 中？**

它是调和器比较同层孩子身份的提示，不是传给组件的业务输入；分离后可避免组件误把它当普通属性。

**3. `type` 相同就一定复用吗？**

不一定。单节点通常还要满足 key 相同；列表中还受同层匹配和位置变化影响，最终由 child reconciler 决定。

**4. children 为什么有时是值、有时是数组？**

`createElement` 对一个孩子直接保存，多个孩子保存为数组，调和器再按单文本、单 Element 或数组走不同路径。

### 容易说错

- 不要把 ReactElement 叫作“真实节点”或 Fiber；它只是普通描述对象。
- 不要说 `key` 会自动传入组件；本仓库会从 props 中剔除它。
- 不要声称本仓库已经支持 ref 全流程；这里只解析并保存 `ref`。
- 不要说组件函数在 `createElement` 时执行；它在 `beginWork` 的函数组件路径中执行。

### 源码入口

- `packages/shared/src/ReactTypes.ts`：ReactElement、Key、Ref 等类型。
- `packages/react/src/ReactElement.ts`：`createElement` 与 children 归一。
- `packages/react-reconciler/src/fiber.ts`：Element 转 Fiber。
- `packages/react-reconciler/src/childFiber.ts`：Element 身份校验与协调。
- `packages/react-reconciler/src/completeWork.ts`：宿主实例的创建时机。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./03-mini-react包结构与依赖方向.md) · [下一章 →](./05-JSX与jsx-runtime与typeof.md)
