# 第 20 章：DOM 属性更新与简易事件

[← 返回总目录](../../React设计与实现.md) · [上一章](./19-HostConfig抽象.md) · [下一章 →](./21-createRoot与updateContainer.md)

同一个按钮再次渲染时，新 props 不仅会增加属性，也可能让旧的 `title`、样式或事件消失。HostConfig 要把这份差异落实到 DOM。事件又多了一层变化：`onClick` 没有直接绑在按钮上，点击仍然能沿父节点触发处理函数。

> 主文件：`packages/react-dom/src/hostConfig.ts`

## 20.1 从最小更新看 `applyProps` 的两趟处理

下面两次渲染之间，`className` 改了，`title` 和 `disabled` 则从对象里消失了：

```tsx
// 第一次
<button className="save" title="保存" disabled>
  保存
</button>

// 第二次
<button className="saved">已保存</button>
```

如果更新只写入 `class="saved"`，旧的 `title` 和 `disabled` 会留在元素上。`applyProps(domElement, nextProps, prevProps?)` 为此走两趟。先遍历旧 props，删掉新对象里已经没有的键。再遍历新 props，写入这一轮的值。

要不要进入 `applyProps`，由 reconciler 先决定。`completeWork` 用 `Object.is` 比较新旧 props，并且跳过 `children`。完全没变就不会打 `Update`，Commit 也不会调用 `commitUpdate`。一旦进来，`applyProps` 不再做第二次相等比较，而是按键删除和重写。

清理旧键的条件是 `nextProps[key] === undefined`。键还在、值是 `null` 或 `false` 时，第一趟认为它没有消失。`className` 对应真实的 `class` attribute。整个 `style` 从对象里消失时，删除 `style` attribute。普通字段用 `removeAttribute`。事件则去掉旧处理函数。`children`、`key` 和 `ref` 在 `RESERVED_PROPS` 里，两趟都会跳过。

第二趟按键的种类分叉：

- `onClick` 写入点击委托表。其他 `onXxx` 交给 `setListener`。
- `className` 在 `null` / `false` 判断之前就处理。`className={null}` 会 `setAttribute('class', '')`。`className={false}` 会写成 `class="false"`，因为 `??` 只替换 `null` 和 `undefined`。
- `style` 是对象时，`Object.assign(domElement.style, value)` 做浅合并。`style={null}` 或 `style={false}` 才会删掉整个 `style` attribute。
- 其他字段里，`null`、`undefined` 和 `false` 执行 `removeAttribute`。`true` 写成值为空字符串的 attribute，例如 `disabled={true}` 变成 `disabled=""`。其余值用 `String(value)` 写入。

所以上面的第二次渲染会把 `class` 改成 `saved`，并移除 `title` 和 `disabled`。这是“键从新对象里消失”的路径。它和“键还在，显式传入 `null`”不是同一段代码。

首次创建没有旧 props。`createInstance` 只走第二趟。后续更新发生在 Commit：`commitWork` 调用 `hostConfig.commitUpdate`，把 `alternate.memoizedProps` 和这一轮的 `memoizedProps` 交给 `applyProps`。

`children` 的变化由 Fiber 子树负责。文本最终落到 `commitTextUpdate`，不会写成名为 `children` 的 attribute。`key` 只参与调和。`ref` 虽然也被跳过，却会在另一条路径生效：`beginWork` 标记 `Ref`，DOM Mutation 完成后，Layout 阶段的 `commitAttachRef` 才把宿主实例写入对象 ref，或传给函数 ref。

## 20.2 `onClick` 为什么只在根容器监听

父子节点都声明点击处理函数时：

```tsx
<div onClick={() => console.log('parent')}>
  <button onClick={(event) => console.log('button', event.type)}>
    保存
  </button>
</div>
```

DOM 上不会为这两个节点各注册一次原生 `click`。`createRoot(container)` 调用 `ensureRootClickDelegation(container)`，在根容器上安装一个监听器。处理过的容器放进 `WeakSet`。对同一个容器再次 `createRoot`，不会重复 `addEventListener`。节点自己的函数记在另一张表里：

```text
clickHandlers: WeakMap<DOM 节点, click 处理函数>
```

更新 `onClick` 时，替换或删除表中的函数即可，不必反复改按钮的原生监听器。`WeakMap` 的键是节点本身。节点若已经没有别的引用，这张表不会单独把它留在内存里。

`eventNameFromProp` 把 `on` 后面的部分转成小写。只有结果正好是 `click` 才进这张表。`onClickCapture` 会得到 `clickcapture`，随后走下面的直接绑定，不会进入捕获阶段。

浏览器把点击交给根容器后，`dispatchDelegatedClick` 从原生 `event.target` 出发，沿 `parentNode` 向上查表：

```text
event.target（button）
  → 调用 button 对应的 click 处理函数
  → parentNode（div）
  → 调用 div 对应的 click 处理函数
  → 到达根容器（event.currentTarget）后停止
```

根容器是这次原生监听的 `event.currentTarget`。循环走到这里就结束，不会再查容器自己在表里的函数。React 树画出来的节点都在容器里面，容器本身不是 `createInstance` 创建的那批节点。

每次调用用户函数之后，派发器检查原生事件的 `cancelBubble`。处理函数若调用 `event.stopPropagation()`，当前函数仍会执行完，更靠外的节点不再调用。这段派发使用同一个浏览器 `Event`，没有构造 SyntheticEvent，也没有单独收集捕获监听器。

其他 `onXxx` 直接绑到对应 DOM 节点，用来和委托路径对照。`setListener` 用 `WeakMap<HTMLElement, Map<string, EventListener>>` 记住各节点的旧函数。更新时先 `removeEventListener`。新值仍是函数，再 `addEventListener`。新值不是函数，就只删除旧监听。因此两条路径一直不同：`onClick` 由根容器委托，其余 `onXxx` 逐节点直绑。

## 20.3 样式与事件还省略了什么

`style` 更新采用浅合并，新对象没写到的旧样式会留下：

```tsx
// 第一次
<div style={{ color: 'red', marginTop: '8px' }} />

// 第二次
<div style={{ color: 'blue' }} />
```

第二次渲染把 `color` 改成蓝色，`marginTop` 仍是 `8px`。`style={{}}` 也删不掉旧项，因为空对象赋上去不会清除已有的样式声明。只有整个 `style` prop 变成 `null`、`false`，或从 props 里消失，清理逻辑才会删除完整的 `style` attribute。若只想清掉一个样式项，这份实现需要给该项传空字符串，例如 `marginTop: ''`。官方 React 会比较前后两个 style 对象，并清理消失的样式键。

事件名称也不宜从这份实现直接类推到官方行为。这里把普通 `onXxx` 转成小写原生事件名，所以 `onChange` 得到的是 `change`，监听器加在目标节点的冒泡阶段。官方 React DOM 会沿 React 树收集捕获和冒泡，向回调提供 SyntheticEvent，并处理事件名、兼容性和更新优先级。官方的 `onChange` 不是原生 `change` 的简单别名。

这份实现保留了两条容易观察的路径：根监听器怎样派发 `onClick`，以及逐节点监听怎样在 props 更新时更换函数。

## 本章回顾

- `applyProps` 在 reconciler 判定 props 有变化后才会执行。它先清理新对象中缺失的旧键，再按种类写入这一轮 props。
- `className={null}` 会留下空的 `class`。普通属性的 `null` / `false` 才会 `removeAttribute`。`children`、`key` 和 `ref` 各有自己的路径。
- `onClick` 函数保存在节点到处理函数的 `WeakMap` 中，由根容器监听器沿 `parentNode` 冒泡派发，走到容器自己就停。
- 其他 `onXxx` 直接绑到节点。更新时先移除旧监听器，再按新值决定是否重绑。名字不是 `click` 的，都走这条路径。
- style 只做浅合并。事件使用原生 `Event` 和简化名称映射。这两处都不等同于官方 React DOM。

### 源码入口

- `packages/react-dom/src/hostConfig.ts`：`applyProps`、`setListener`、`setClickHandler`
- `packages/react-dom/src/hostConfig.ts`：`ensureRootClickDelegation`、`dispatchDelegatedClick`
- `packages/react-reconciler/src/beginWork.ts`：`markRef`
- `packages/react-reconciler/src/commitWork.ts`：`commitWork`、`commitLayoutEffectsOnFiber`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./19-HostConfig抽象.md) · [下一章 →](./21-createRoot与updateContainer.md)
