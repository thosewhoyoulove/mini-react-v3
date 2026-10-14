# 第 20 章：DOM 属性更新与简易事件

[← 返回总目录](../../React设计与实现.md) · [上一章](./19-HostConfig抽象.md) · [下一章 →](./21-createRoot与updateContainer.md)

同一个按钮第二次渲染时，旧的 `className`、旧事件和旧样式该由谁清理？如果 `onClick` 没有绑在按钮上，点击又为什么仍能触发？这两个问题都落在 DOM HostConfig：它把 Fiber 的 props 变化翻译成浏览器操作，也刻意保留了两种事件绑定方式供我们比较。

> 主文件：`packages/react-dom/src/hostConfig.ts`

## 本章书签

- [20.1 从最小更新看 `applyProps` 的两趟处理](#201-从最小更新看-applyprops-的两趟处理)
- [20.2 `onClick` 为什么只在根容器监听](#202-onclick-为什么只在根容器监听)
- [20.3 教学实现的边界与官方 React 的差异](#203-教学实现的边界与官方-react-的差异)
- [面试复习](#面试复习)

---

## 20.1 从最小更新看 `applyProps` 的两趟处理

先看一个属性会减少的例子：

```tsx
// 第一次
<button className="save" title="保存" disabled>
  保存
</button>

// 第二次
<button className="saved">已保存</button>
```

第二次提交不能只写入 `class="saved"`，还必须删除旧的 `title` 和 `disabled`。因此本仓库的 `applyProps(domElement, nextProps, prevProps?)` 在更新时分两趟执行。

**第一趟：删除旧有、新无的键。** 它遍历 `prevProps`，只处理 `nextProps[key] === undefined` 的字段：

- `className` 删除真实的 `class` attribute；
- `style` 删除整个 `style` attribute；
- 事件移除旧处理函数；
- 普通字段调用 `removeAttribute`；
- `children`、`key`、`ref` 是保留字段，直接跳过。

若新值明确写成 `null` 或 `false`，这个键仍存在，不会在第一趟删除；第二趟会处理它。这个细节避免把“键消失”和“键仍在但值为空”混为一谈。

**第二趟：写入全部新 props。**

| 新 prop | 当前仓库的处理 |
| --- | --- |
| `className` | 写成 `class` attribute |
| `style` 对象 | `Object.assign(domElement.style, value)` |
| `onXxx` | 进入事件分支 |
| `null`、`undefined`、`false` | 删除 attribute |
| `true` | 写入值为空字符串的 attribute |
| 其他值 | 转成字符串后写入 attribute |

首次创建 DOM 时，`createInstance` 没有旧 props，只需第二趟。更新时，Commit 阶段的 `commitWork` 调用 `hostConfig.commitUpdate`，后者带着新旧 props 再执行两趟。

`children` 不能由 `applyProps` 写成 attribute。孩子由 Fiber 子树管理，文本变化最终走 `commitTextUpdate`。`key` 只服务于调和，不能出现在 DOM 上。

`ref` 也会被 `applyProps` 跳过，但这不表示它被忽略。`beginWork` 比较 ref 并打上 `Ref` 标记；DOM Mutation 完成后，reconciler 在 **Layout 阶段**调用 `commitAttachRef`，把宿主实例交给函数 ref，或写入对象 ref 的 `current`。属性写入与 ref 写入属于不同职责。

## 20.2 `onClick` 为什么只在根容器监听

考虑父子节点都有点击处理函数：

```tsx
<div onClick={() => console.log('parent')}>
  <button onClick={(event) => console.log('button', event.type)}>
    保存
  </button>
</div>
```

本仓库不会在 `div` 和 `button` 上分别注册原生 `click`。`createRoot(container)` 会先调用 `ensureRootClickDelegation(container)`，只在根容器挂一个 `click` 监听器。一个 `WeakSet` 记录已经处理过的容器，避免同一容器重复绑定。

各节点的 `onClick` 函数存入另一张表：

```text
clickHandlers: WeakMap<DOM 节点, click 处理函数>
```

`WeakMap` 不拥有键的强引用；DOM 节点不再被其他地方引用时，这张表不会单独阻止它被回收。更新 `onClick` 只是替换或删除表中的函数，不会反复在按钮上执行 `addEventListener`。

点击按钮后，容器监听器收到浏览器原生 `Event`，`dispatchDelegatedClick` 按下面的顺序派发：

```text
event.target（button）
  → 查 clickHandlers，有函数就调用
  → event.target.parentNode（div）
  → 查表并调用
  → 根容器：停止，不调用容器对应的 prop
```

循环从 `event.target` 开始，每次沿 `parentNode` 向上，遇到 `event.currentTarget` 就结束。对这个原生监听器而言，`currentTarget` 正是根容器。每调用一次处理函数后都会检查 `event.cancelBubble`；用户调用原生 `event.stopPropagation()` 后，该值变为真，派发立即停止。

这是一套很小的冒泡模型。回调拿到的是同一个浏览器原生事件，不是 SyntheticEvent；代码也没有收集捕获阶段监听器。

其他 `onXxx` 走另一条路径。`eventNameFromProp` 把 `onInput`、`onChange` 机械地转成 `input`、`change`。`setListener` 用
`WeakMap<HTMLElement, Map<string, EventListener>>` 记住每个节点的旧函数：更新时先 `removeEventListener`，新值是函数时再逐节点 `addEventListener`。因此，**当前仓库只有 `onClick` 使用根容器委托，其余 `onXxx` 仍直接绑定在对应 DOM 节点上。**

## 20.3 教学实现的边界与官方 React 的差异

先看 `style` 的边界：

```tsx
// 第一次
<div style={{ color: 'red', marginTop: '8px' }} />

// 第二次
<div style={{ color: 'blue' }} />
```

本仓库第二次只做浅合并。`color` 会变成蓝色，但旧的 `marginTop` 不会因新对象缺少该键而自动清除。只有整个 `style` prop 消失，第一趟才删除完整的 `style` attribute。若要单独清理，教学代码中需要显式传入空字符串。官方 React 会比较前后 style 对象并清理消失的样式项，还会处理更多值转换规则。

事件方面也要分清三层：

| 能力 | 当前仓库 | 官方 React DOM |
| --- | --- | --- |
| `click` 绑定位置 | 根容器一次 | 通常由根事件系统集中监听 |
| 其他事件 | 每个 DOM 节点直接监听 | 按事件类型采用完整的事件系统，存在例外与特殊处理 |
| 派发路径 | 从原生 `target` 沿 `parentNode` 向上 | 根据 React 树收集捕获与冒泡监听器 |
| 回调参数 | 浏览器原生 `Event` | `SyntheticEvent` |
| 名称语义 | `onXxx` 简单转小写 | 事件插件、兼容处理和特殊映射 |
| 更新优先级 | 没有事件优先级映射 | 事件类型会参与更新优先级选择 |

所以，本仓库实现了“根容器委托”这个关键想法，却不是官方合成事件系统的缩小复刻。尤其不能由这里的 `onChange → change` 推断官方 `onChange` 只是原生 `change` 的别名。

下一章继续追踪入口：根容器上的 click 委托在何时建立，React element 又怎样从 `root.render` 进入调和器。

## 面试复习

**一句话：** `applyProps` 先删旧有新无，再写新值；`onClick` 存在 `WeakMap` 并由根容器沿 `parentNode` 派发，其他 `onXxx` 仍逐节点绑定。

**Q：`ref` 为什么不由 `applyProps` 设置？**

A：它不是 DOM attribute。reconciler 给 Fiber 打 `Ref` 标记，并在 Commit 的 Layout 阶段写入实例。

**Q：`stopPropagation()` 在教学委托中怎样生效？**

A：处理函数执行后，派发器检查原生事件的 `cancelBubble`；为真就不再访问父节点。

**Q：style 更新完整吗？**

A：不完整。当前仓库只浅合并新对象，不会自动清除新对象中缺失的旧样式键。

### 源码入口

- `packages/react-dom/src/hostConfig.ts`：`applyProps`、`setListener`、`setClickHandler`
- `packages/react-dom/src/hostConfig.ts`：`ensureRootClickDelegation`、`dispatchDelegatedClick`
- `packages/react-reconciler/src/beginWork.ts`：`markRef`
- `packages/react-reconciler/src/commitWork.ts`：`commitWork`、`commitLayoutEffectsOnFiber`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./19-HostConfig抽象.md) · [下一章 →](./21-createRoot与updateContainer.md)
