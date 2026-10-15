# 第 20 章：DOM 属性更新与简易事件

[← 返回总目录](../../React设计与实现.md) · [上一章](./19-HostConfig抽象.md) · [下一章 →](./21-createRoot与updateContainer.md)

同一个按钮再次渲染时，新 props 不仅会增加属性，也可能让旧的 `title`、样式或事件消失。HostConfig 要把这份差异落实到 DOM。事件又多了一层变化：`onClick` 没有直接绑在按钮上，点击仍然能沿父节点触发处理函数。

> 主文件：`packages/react-dom/src/hostConfig.ts`

## 20.1 从最小更新看 `applyProps` 的两趟处理

下面两次渲染之间，`className` 改了，`title` 和 `disabled` 则消失了：

```tsx
// 第一次
<button className="save" title="保存" disabled>
  保存
</button>

// 第二次
<button className="saved">已保存</button>
```

如果更新只写入 `class="saved"`，旧的 `title` 和 `disabled` 会继续留在元素上。`applyProps(domElement, nextProps, prevProps?)` 为此走两趟：先遍历旧 props，清理那些新对象中已经没有的键；再遍历新 props，写入这一轮的值。

清理旧键时，判断条件是 `nextProps[key] === undefined`。`className` 对应真实的 `class` attribute，`style` 消失时会删除整个 `style` attribute，普通字段使用 `removeAttribute`，事件则移除旧处理函数。`children`、`key` 和 `ref` 不属于这条 DOM 属性路径，会被跳过。

显式传入 `null` 或 `false` 时，键还在新对象里，第一趟不会把它当成“缺失”；第二趟看到值后同样会删除对应 attribute。布尔值 `true` 写成值为空字符串的 attribute，其他普通值转成字符串。`className` 仍映射到 `class`，`style` 对象通过 `Object.assign(domElement.style, value)` 合并，`onXxx` 交给事件分支。

首次创建元素没有旧 props，`createInstance` 只需写入新值。后续更新发生在 Commit：`commitWork` 调用 `hostConfig.commitUpdate`，把新旧 props 一并交给 `applyProps`。

`children` 的变化由 Fiber 子树负责，文本更新最终落到 `commitTextUpdate`，不会被写成名为 `children` 的 attribute。`key` 只参与调和。ref 虽然也被跳过，却会在另一条路径生效：`beginWork` 标记 `Ref`，DOM Mutation 完成后，Layout 阶段的 `commitAttachRef` 才把宿主实例写入对象 ref，或传给函数 ref。

## 20.2 `onClick` 为什么只在根容器监听

父子节点都声明点击处理函数时：

```tsx
<div onClick={() => console.log('parent')}>
  <button onClick={(event) => console.log('button', event.type)}>
    保存
  </button>
</div>
```

DOM 上并不会为这两个节点各注册一次原生 `click`。`createRoot(container)` 会调用 `ensureRootClickDelegation(container)`，在根容器安装一个监听器；处理过的容器记录在 `WeakSet` 中，重复调用不会重复绑定。节点自己的函数则保存在另一张弱引用表里：

```text
clickHandlers: WeakMap<DOM 节点, click 处理函数>
```

更新 `onClick` 时只需替换或删除表中的函数，不必反复操作按钮的原生监听器。`WeakMap` 也不会因为保存了处理函数，就单独阻止对应 DOM 节点被垃圾回收。

浏览器把点击事件交给根容器后，`dispatchDelegatedClick` 从原生 `event.target` 出发，沿 `parentNode` 向上查表：

```text
event.target（button）
  → 调用 button 对应的 click 处理函数
  → parentNode（div）
  → 调用 div 对应的 click 处理函数
  → 到达根容器后停止
```

根容器是这次原生监听的 `event.currentTarget`，循环走到这里便结束，不会查找容器自身对应的 prop。每次调用用户函数后，派发器还会检查原生事件的 `cancelBubble`；处理函数若调用 `event.stopPropagation()`，向父节点的遍历就停在当下。

这段派发使用的是同一个浏览器 `Event`，没有构造 SyntheticEvent，也没有收集捕获阶段的监听器。它只为 `onClick` 展示根容器委托。其他 `onXxx` 会由 `eventNameFromProp` 把名称简单转为小写，例如 `onInput` 变成 `input`，随后直接绑定到对应 DOM 节点。

直接绑定也要处理更新。`setListener` 用 `WeakMap<HTMLElement, Map<string, EventListener>>` 保存各节点的旧函数，更新时先执行 `removeEventListener`；新值仍是函数，再执行 `addEventListener`。于是两条事件路径始终不同：`onClick` 由根容器委托，其余 `onXxx` 逐节点直绑。

## 20.3 样式与事件还省略了什么

`style` 更新采用浅合并，会留下新对象中没有提到的旧样式：

```tsx
// 第一次
<div style={{ color: 'red', marginTop: '8px' }} />

// 第二次
<div style={{ color: 'blue' }} />
```

第二次渲染会把 `color` 改成蓝色，`marginTop` 仍是 `8px`。只有整个 `style` prop 消失时，第一趟清理才删除完整的 `style` attribute；若只想清掉一个样式项，这份实现需要显式给该项传空字符串。官方 React 会比较前后两个 style 对象，并清理消失的样式键。

事件名称也不宜从这份实现直接类推到官方行为。这里把普通 `onXxx` 机械地转成小写原生事件名，所以 `onChange` 只会得到 `change`。官方 React DOM 会依据 React 树收集捕获与冒泡监听器，向回调提供 SyntheticEvent，并对事件名称、兼容性和更新优先级做更多处理；官方的 `onChange` 并不是原生 `change` 的简单别名。

这份小型实现保留了最容易观察的两种机制：一次根监听如何派发 `onClick`，以及逐节点监听怎样在 props 更新时更换函数。下一章会回到入口，看看 `createRoot` 在何时装上根监听器，又怎样把 element 送进调和器。

## 本章回顾

- `applyProps` 更新时先清理新对象中缺失的旧键，再写入这一轮 props；`children`、`key` 和 `ref` 各有自己的处理路径。
- `onClick` 函数保存在节点到处理函数的 `WeakMap` 中，由根容器监听器沿 `parentNode` 冒泡派发。
- 其他 `onXxx` 仍直接绑定到节点，更新时先移除旧监听器，再按新值决定是否重绑。
- style 只做浅合并，事件也使用原生 `Event` 和简化名称映射，这两处都不等同于官方 React DOM。

### 源码入口

- `packages/react-dom/src/hostConfig.ts`：`applyProps`、`setListener`、`setClickHandler`
- `packages/react-dom/src/hostConfig.ts`：`ensureRootClickDelegation`、`dispatchDelegatedClick`
- `packages/react-reconciler/src/beginWork.ts`：`markRef`
- `packages/react-reconciler/src/commitWork.ts`：`commitWork`、`commitLayoutEffectsOnFiber`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./19-HostConfig抽象.md) · [下一章 →](./21-createRoot与updateContainer.md)
