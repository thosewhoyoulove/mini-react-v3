import {
  ErrorBoundary,
  Fragment,
  Suspense,
  createContext,
  createElement,
  forwardRef,
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  ImmediatePriority,
  LowPriority,
  unstable_now,
  unstable_scheduleCallback,
} from 'scheduler';
import {
  createContainer,
  updateContainer,
  type HostConfig,
} from 'react-reconciler';
import {
  dispatchDelegatedClick,
  hostConfig as domHostConfig,
  peekClickHandler,
} from '../packages/react-dom/src/hostConfig';

/**
 * 不依赖浏览器的行为测试。
 *
 * 内存 HostConfig 保留每个宿主节点的对象身份，用来证明 Diff 到底是复用、移动
 * 还是删除；最后一条测试单独用 FakeElement 验证 react-dom 的属性与事件翻译。
 */

/** 内存宿主根，只保存直接孩子。 */
type TestContainer = {
  /** 已经 Commit 到根容器的宿主节点。 */
  children: TestNode[];
};

/** 内存宿主元素，对应浏览器 HTMLElement。 */
type TestElement = {
  /** 与 TestText 区分的判别字段。 */
  kind: 'element';

  /** 原生标签名。 */
  type: string;

  /** 最近一次 Commit 后的宿主属性。 */
  props: Record<string, unknown>;

  /** 直接宿主孩子，顺序就是最终显示顺序。 */
  children: TestNode[];

  /** 所属宿主父节点；删除后恢复 null。 */
  parent: TestElement | TestContainer | null;
};

/** 内存文本节点，对应浏览器 Text。 */
type TestText = {
  /** 与 TestElement 区分的判别字段。 */
  kind: 'text';

  /** 最近一次 Commit 后的文本内容。 */
  text: string;

  /** 所属宿主父节点；删除后恢复 null。 */
  parent: TestElement | TestContainer | null;
};

/** 内存宿主树允许出现的两种节点。 */
type TestNode = TestElement | TestText;

/** 一条顺序执行的测试。 */
type TestCase = {
  /** 输出到终端的行为描述。 */
  name: string;

  /** 同步或异步测试主体。 */
  run: () => void | Promise<void>;
};

/** 待执行的测试。顺序执行，避免 reconciler 教学版的单根全局状态互相干扰。 */
const tests: TestCase[] = [];

/** 注册一个无需第三方框架的最小测试。 */
function test(name: string, run: TestCase['run']): void {
  tests.push({ name, run });
}

/** 失败时同时打印期望值和实际值，方便把断言对回源码路径。 */
function equal<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${message}\n  expected: ${String(expected)}\n  received: ${String(actual)}`,
    );
  }
}

/** 判断条件必须成立。 */
function ok(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

/**
 * 从旧父节点摘掉再插入新位置，模拟 DOM appendChild / insertBefore 的移动语义。
 * keyed Diff 的 Placement 测试依赖这个行为判断“复用并移动”，而不是误判成复制。
 */
function insertNode(
  parent: TestElement | TestContainer,
  child: TestNode,
  before: TestNode | null,
): void {
  if (child.parent != null) {
    const oldIndex = child.parent.children.indexOf(child);
    if (oldIndex !== -1) {
      child.parent.children.splice(oldIndex, 1);
    }
  }
  const nextIndex = before == null ? parent.children.length : parent.children.indexOf(before);
  parent.children.splice(nextIndex, 0, child);
  child.parent = parent;
}

/** 删除节点，并断开 parent，模拟真实 DOM 的 removeChild。 */
function removeNode(parent: TestElement | TestContainer, child: TestNode): void {
  const index = parent.children.indexOf(child);
  if (index === -1) {
    throw new Error('Cannot remove a node that is not a child of this parent');
  }
  parent.children.splice(index, 1);
  child.parent = null;
}

/**
 * 测试宿主：把 reconciler 的宿主操作落到普通对象树。
 * 它保留节点对象身份，因此可以直接断言 Fiber 是否真的复用了宿主节点。
 */
const testHostConfig: HostConfig<
  string,
  Record<string, unknown>,
  TestContainer,
  TestElement,
  TestText
> = {
  createInstance(type, props) {
    return {
      kind: 'element',
      type,
      props: { ...props },
      children: [],
      parent: null,
    };
  },
  createTextInstance(text) {
    return { kind: 'text', text, parent: null };
  },
  appendChild(parent, child) {
    insertNode(parent, child, null);
  },
  appendChildToContainer(container, child) {
    insertNode(container, child, null);
  },
  insertBefore(parent, child, before) {
    insertNode(parent, child, before);
  },
  insertInContainerBefore(container, child, before) {
    insertNode(container, child, before);
  },
  removeChild(parent, child) {
    removeNode(parent, child);
  },
  removeChildFromContainer(container, child) {
    removeNode(container, child);
  },
  commitUpdate(instance, _type, _oldProps, newProps) {
    instance.props = { ...newProps };
  },
  commitTextUpdate(textInstance, _oldText, newText) {
    textInstance.text = newText;
  },
};

/** 创建一棵使用内存宿主的空应用树。 */
function createTestRoot() {
  const container: TestContainer = { children: [] };
  const root = createContainer(container, testHostConfig);
  return { container, root };
}

/** root.render 使用 SyncLane 约微任务；让出一次微任务即可看到 Commit 结果。 */
async function flushSyncRender(): Promise<void> {
  await Promise.resolve();
}

/** 等待 Scheduler 的 MessageChannel 宏任务执行，主要用于 DefaultLane 与 Passive Effect。 */
async function waitFor(
  predicate: () => boolean,
  message: string,
  timeout = 500,
): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeout) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 读取元素的直接文本孩子，测试只用它检查简单标签内容。 */
function textOf(element: TestElement): string {
  return element.children
    .map((child) => (child.kind === 'text' ? child.text : ''))
    .join('');
}

test('createElement 会拆出 key/ref，并按孩子数量规范化 props.children', () => {
  const ref = { current: null };
  const element = createElement(
    'button',
    { key: 7, ref, title: 'save' },
    'Save',
  );

  equal(element.key, '7', 'key 应统一转成字符串');
  equal(element.ref, ref, 'ref 应保存在 Element 顶层');
  equal(element.props.title, 'save', '普通 config 字段应复制到 props');
  equal(element.props.children, 'Save', '单个孩子应直接保存，不额外套数组');
  equal('key' in element.props, false, 'key 不应泄漏进 props');
  equal('ref' in element.props, false, 'ref 不应泄漏进 props');
});

test('相同 type 的 Host Fiber 会复用 DOM，并只更新文本', async () => {
  const { container, root } = createTestRoot();
  updateContainer(createElement('p', { title: 'before' }, 'count: 0'), root);
  await flushSyncRender();

  const paragraph = container.children[0] as TestElement;
  const text = paragraph.children[0] as TestText;
  updateContainer(createElement('p', { title: 'after' }, 'count: 1'), root);
  await flushSyncRender();

  equal(container.children[0], paragraph, '相同 type 应复用原宿主元素');
  equal(paragraph.children[0], text, 'HostText 应复用原文本节点');
  equal(paragraph.props.title, 'after', 'Commit 应更新宿主 props');
  equal(text.text, 'count: 1', 'Commit 应更新文本内容');
});

test('keyed Diff 会复用并移动节点，而不是整组重建', async () => {
  const { container, root } = createTestRoot();
  const list = (items: string[]) =>
    createElement(
      'ul',
      null,
      ...items.map((item) => createElement('li', { key: item }, item)),
    );

  updateContainer(list(['A', 'B', 'C']), root);
  await flushSyncRender();
  const ul = container.children[0] as TestElement;
  const [a, b, c] = ul.children;

  updateContainer(list(['C', 'A', 'B']), root);
  await flushSyncRender();

  equal(ul.children.map((child) => textOf(child as TestElement)).join(','), 'C,A,B', '列表顺序应更新');
  equal(ul.children[0], c, 'C 应复用原节点并移动到开头');
  equal(ul.children[1], a, 'A 应复用原节点');
  equal(ul.children[2], b, 'B 应复用原节点');
});

test('新列表变短时会删除多余的宿主节点', async () => {
  const { container, root } = createTestRoot();
  const list = (items: string[]) =>
    createElement(
      'ul',
      null,
      ...items.map((item) => createElement('li', { key: item }, item)),
    );

  updateContainer(list(['A', 'B', 'C']), root);
  await flushSyncRender();
  const ul = container.children[0] as TestElement;
  const removed = ul.children[1];

  updateContainer(list(['A', 'C']), root);
  await flushSyncRender();

  equal(ul.children.map((child) => textOf(child as TestElement)).join(','), 'A,C', 'B 应从列表中删除');
  equal(removed.parent, null, '被删除的节点应断开宿主 parent');
});

test('同一事件的函数式 setState 会共用一次调度并按入队顺序累加', async () => {
  const { container, root } = createTestRoot();
  const captured: {
    /** Counter 首次执行时写入的稳定 dispatch。 */
    dispatch: ((action: number | ((value: number) => number)) => void) | null;
  } = { dispatch: null };
  let renderCount = 0;

  function Counter() {
    renderCount++;
    const [count, dispatch] = useState(0);
    captured.dispatch = dispatch;
    return createElement('span', null, String(count));
  }

  updateContainer(createElement(Counter, null), root);
  await flushSyncRender();
  const setCount = captured.dispatch;
  ok(setCount != null, '首次渲染后应取得 dispatch');

  setCount((value) => value + 1);
  setCount((value) => value + 1);
  setCount((value) => value + 1);
  await waitFor(
    () => textOf(container.children[0] as TestElement) === '3',
    'DefaultLane 更新没有在 Scheduler 中完成',
  );

  equal(renderCount, 2, '三次同步入队应合并成一次后续 render');
});

test('Layout 与 Passive Effect 按 Commit 阶段执行，并在依赖变化时先清理', async () => {
  const { root } = createTestRoot();
  const events: string[] = [];

  function Effects(props: { value: number }) {
    events.push(`render ${props.value}`);
    useLayoutEffect(() => {
      events.push(`layout create ${props.value}`);
      return () => events.push(`layout destroy ${props.value}`);
    }, [props.value]);
    useEffect(() => {
      events.push(`passive create ${props.value}`);
      return () => events.push(`passive destroy ${props.value}`);
    }, [props.value]);
    return createElement('div', null, String(props.value));
  }

  updateContainer(createElement(Effects, { value: 1 }), root);
  await flushSyncRender();
  equal(events.join(' | '), 'render 1 | layout create 1', 'Layout create 应在同步 Commit 中执行');
  await waitFor(() => events.includes('passive create 1'), 'Passive create 没有在后续 Scheduler 任务执行');

  const beforeStableDeps = events.length;
  updateContainer(createElement(Effects, { value: 1 }), root);
  await flushSyncRender();
  equal(
    events.slice(beforeStableDeps).join(' | '),
    '',
    'props 相同且没有 lane 时跳过函数，Effect 不会 cleanup/create',
  );

  updateContainer(createElement(Effects, { value: 2 }), root);
  await flushSyncRender();
  equal(
    events.slice(-3).join(' | '),
    'render 2 | layout destroy 1 | layout create 2',
    '更新时 Layout 应在 Mutation 清理、Layout 阶段重新创建',
  );
  await waitFor(() => events.includes('passive create 2'), '更新后的 Passive Effect 没有执行');
  equal(
    events.slice(-2).join(' | '),
    'passive destroy 1 | passive create 2',
    'Passive Effect 应在后续任务先 destroy 再 create',
  );

  updateContainer(null, root);
  await flushSyncRender();
  equal(
    events.slice(-2).join(' | '),
    'layout destroy 2 | passive destroy 2',
    '教学版删除子树时会在 Mutation 中同步清理两种 Effect',
  );
});

/** react-dom 单元测试使用的最小 HTMLElement 替身。 */
class FakeElement {
  /** 当前 attribute 名值表。 */
  attributes = new Map<string, string>();

  /** 当前原生事件名到监听函数的映射。 */
  listeners = new Map<string, EventListener>();

  /** Object.assign 可写入的行内样式对象。 */
  style: Record<string, unknown> = {};

  /** 委托派发沿 parentNode 向上走。 */
  parentNode: FakeElement | null = null;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'style') {
      this.style = {};
    }
  }

  addEventListener(name: string, listener: EventListener): void {
    this.listeners.set(name, listener);
  }

  removeEventListener(name: string, listener: EventListener): void {
    if (this.listeners.get(name) === listener) {
      this.listeners.delete(name);
    }
  }
}

test('DOM HostConfig 会更新 className、布尔属性和 onXxx 监听器', () => {
  const element = new FakeElement();
  const firstClick = () => undefined;
  const nextClick = () => undefined;
  const previous = {
    className: 'before',
    disabled: true,
    onClick: firstClick,
  };
  const mouseDown = () => undefined;
  const next = {
    className: 'after',
    disabled: false,
    onClick: nextClick,
    onMouseDown: mouseDown,
  };

  domHostConfig.commitUpdate(
    element as unknown as HTMLElement,
    'button',
    previous,
    next,
  );

  equal(element.attributes.get('class'), 'after', 'className 应映射到 class');
  equal(element.attributes.has('disabled'), false, 'false 布尔属性应删除');
  equal(element.listeners.has('click'), false, 'click 不在节点上 addEventListener');
  equal(
    peekClickHandler(element),
    nextClick as EventListener,
    'click 记在委托表里',
  );
  equal(
    element.listeners.get('mousedown'),
    mouseDown as EventListener,
    '其余事件仍逐节点监听',
  );

  const parent = new FakeElement();
  element.parentNode = parent;
  let clicks = 0;
  dispatchDelegatedClick({
    target: element,
    currentTarget: parent,
    cancelBubble: false,
  } as unknown as Event);
  equal(clicks, 0, '还没把计数函数写进委托表时不应触发');
  domHostConfig.commitUpdate(
    element as unknown as HTMLElement,
    'button',
    next,
    { onClick: () => { clicks += 1; } },
  );
  dispatchDelegatedClick({
    target: element,
    currentTarget: parent,
    cancelBubble: false,
  } as unknown as Event);
  equal(clicks, 1, '容器委托只派发一次');
});

/** 读取根容器下第一个元素的文本，方便断言单节点页面。 */
function rootText(container: TestContainer): string {
  const first = container.children[0];
  if (first == null || first.kind !== 'element') {
    return '';
  }
  return textOf(first);
}

test('props 相同且子树没有 lane 时跳过子函数，子树有 lane 时父函数不能跳过', async () => {
  let childRenders = 0;
  let parentRenders = 0;
  let setTick: (action: number | ((value: number) => number)) => void = () => {};
  let setChild: (action: number | ((value: number) => number)) => void = () => {};

  function Child() {
    childRenders += 1;
    const [n, setN] = useState(0);
    setChild = setN;
    return createElement('span', null, 'c' + n);
  }

  function Parent() {
    parentRenders += 1;
    const [tick, set] = useState(0);
    setTick = set;
    return createElement(
      'div',
      null,
      createElement('span', null, String(tick)),
      createElement(Child, null),
    );
  }

  const { container, root } = createTestRoot();
  updateContainer(createElement(Parent, null), root);
  await flushSyncRender();
  equal(childRenders, 1, '首次渲染子函数执行一次');

  setTick(1);
  await waitFor(() => parentRenders === 2, '父更新没有完成');
  const div = container.children[0] as TestElement;
  equal(textOf(div.children[0] as TestElement), '1', '父状态已经提交');
  equal(childRenders, 1, '子函数被跳过，没有再次执行');

  setChild(1);
  await waitFor(() => childRenders === 2, '子更新没有完成');
  equal(parentRenders, 3, '子树还有 lane 时父函数必须重跑');
  equal(textOf(div.children[1] as TestElement), 'c1', '子状态已经提交');
});

test('Layout 阶段写入 ref，卸载时清空', async () => {
  const hostRef: { current: TestElement | null } = { current: null };
  const fnRef: { current: { type: unknown } | null } = { current: null };

  function Box() {
    return createElement('i', null, 'box');
  }

  const { container, root } = createTestRoot();
  updateContainer(
    createElement(
      'div',
      null,
      createElement('span', { ref: hostRef }, 'host'),
      createElement(Box, { ref: fnRef }),
    ),
    root,
  );
  await flushSyncRender();
  const div = container.children[0] as TestElement;
  equal(hostRef.current, div.children[0], '宿主 ref 指向真实实例');
  equal(fnRef.current?.type, Box, '函数组件 ref 指向 Fiber');

  updateContainer(null, root);
  await flushSyncRender();
  equal(hostRef.current, null, '卸载宿主时 ref 写成 null');
  equal(fnRef.current, null, '卸载函数组件时 ref 写成 null');
});

test('useRef 保持同一对象，useReducer 按序重放，useMemo / useCallback 看依赖', async () => {
  let renders = 0;
  let memoCount = 0;
  let setTick: (value: number) => void = () => {};
  let setN: (value: number) => void = () => {};
  let dispatch: (action: number) => void = () => {};
  let refStable = true;
  let seenRef: { current: number } | null = null;
  let seenCallback: (() => number) | null = null;
  let callbackChanged = false;

  function App() {
    renders += 1;
    const ref = useRef(1);
    if (seenRef == null) {
      seenRef = ref;
    } else if (seenRef !== ref) {
      refStable = false;
    }
    const [tick, setTickState] = useState(0);
    const [n, setNState] = useState(0);
    const [sum, reduce] = useReducer((state: number, action: number) => state + action, 0);
    setTick = setTickState;
    setN = setNState;
    dispatch = reduce;
    const doubled = useMemo(() => {
      memoCount += 1;
      return n * 2;
    }, [n]);
    const callback = useCallback(() => n, [n]);
    if (seenCallback == null) {
      seenCallback = callback;
    } else if (seenCallback !== callback) {
      callbackChanged = true;
      seenCallback = callback;
    }
    return createElement('span', null, `${tick}:${doubled}:${sum}`);
  }

  const { container, root } = createTestRoot();
  updateContainer(createElement(App, null), root);
  await flushSyncRender();
  equal(rootText(container), '0:0:0', '初始 hook 状态');
  equal(memoCount, 1, 'useMemo 首次计算一次');

  setTick(1);
  await waitFor(() => rootText(container) === '1:0:0', '无关状态更新没有提交');
  equal(refStable, true, 'useRef 在更新后仍是同一个对象');
  equal(memoCount, 1, '依赖没变时 useMemo 不重算');
  equal(callbackChanged, false, '依赖没变时 useCallback 保持函数身份');

  dispatch(2);
  dispatch(3);
  await waitFor(() => rootText(container) === '1:0:5', 'useReducer 应合并重放 2 和 3');

  callbackChanged = false;
  setN(4);
  await waitFor(() => rootText(container) === '1:8:5', 'useMemo 依赖变化后没有提交');
  equal(memoCount, 2, '依赖变化时 useMemo 重算一次');
  equal(callbackChanged, true, '依赖变化时 useCallback 换成新函数');
  equal(renders > 1, true, '更新路径确实跑过');
});

test('Fragment 不创建 DOM，两个孩子直接挂到父节点下', async () => {
  const { container, root } = createTestRoot();
  updateContainer(
    createElement(
      Fragment,
      null,
      createElement('span', null, 'a'),
      createElement('span', null, 'b'),
    ),
    root,
  );
  await flushSyncRender();
  equal(container.children.length, 2, 'Fragment 自己不是宿主节点');
  equal(textOf(container.children[0] as TestElement), 'a', '第一个孩子保持顺序');
  equal(textOf(container.children[1] as TestElement), 'b', '第二个孩子保持顺序');
});

test('Context value 变化时消费者不能 bailout，value 不变时可以跳过', async () => {
  const Ctx = createContext('a');
  let consumerRenders = 0;
  let setTick: (value: number) => void = () => {};
  let setValue: (value: string) => void = () => {};

  function Consumer() {
    consumerRenders += 1;
    return createElement('span', null, useContext(Ctx));
  }

  function App() {
    const [tick, setTickState] = useState(0);
    const [value, setValueState] = useState('a');
    setTick = setTickState;
    setValue = setValueState;
    return createElement(
      'div',
      null,
      createElement('span', null, String(tick)),
      createElement(Ctx.Provider, { value }, createElement(Consumer, null)),
    );
  }

  const { container, root } = createTestRoot();
  updateContainer(createElement(App, null), root);
  await flushSyncRender();
  equal(consumerRenders, 1, '消费者首次渲染一次');

  setTick(1);
  await waitFor(() => {
    const div = container.children[0] as TestElement;
    return textOf(div.children[0] as TestElement) === '1';
  }, '父更新没有提交');
  equal(consumerRenders, 1, 'value 没变时消费者被跳过');

  setValue('b');
  await waitFor(() => {
    const div = container.children[0] as TestElement;
    return textOf(div.children[1] as TestElement) === 'b';
  }, 'context 新值没有提交');
  equal(consumerRenders, 2, 'value 变化时即使 props 相同也不能跳过');
});

test('memo 比较通过时跳过内部函数，forwardRef 把 ref 交给宿主节点', async () => {
  let memoRenders = 0;
  let setTick: (value: number) => void = () => {};
  let setN: (value: number) => void = () => {};
  const hostRef: { current: TestElement | null } = { current: null };

  const Box = memo(function Box(props: { n: number }) {
    memoRenders += 1;
    return createElement('span', null, String(props.n));
  });

  const Fancy = forwardRef(function Fancy(
    _props: Record<string, never>,
    ref: { current: TestElement | null },
  ) {
    return createElement('b', { ref }, 'ref');
  });

  function App() {
    const [tick, setTickState] = useState(0);
    const [n, setNState] = useState(1);
    setTick = setTickState;
    setN = setNState;
    return createElement(
      'div',
      null,
      createElement('span', null, String(tick)),
      createElement(Box, { n }),
      createElement(Fancy, { ref: hostRef }),
    );
  }

  const { container, root } = createTestRoot();
  updateContainer(createElement(App, null), root);
  await flushSyncRender();
  const div = container.children[0] as TestElement;
  equal(memoRenders, 1, 'memo 首次渲染内部函数');
  equal(hostRef.current, div.children[2], 'forwardRef 的 ref 指向内部宿主节点');

  setTick(1);
  await waitFor(() => textOf(div.children[0] as TestElement) === '1', '父更新没有提交');
  equal(memoRenders, 1, 'props 浅比较通过时 memo 跳过内部函数');

  setN(2);
  await waitFor(() => textOf(div.children[1] as TestElement) === '2', 'memo 更新没有提交');
  equal(memoRenders, 2, 'props 变化时 memo 进入内部函数');
});

test('高优更新丢掉进行中的 transition，被丢掉的渲染不会提交', async () => {
  const renders: string[] = [];
  const committed: string[] = [];
  let setT: (value: number) => void = () => {};

  function App() {
    const [n, setN] = useState(0);
    const [t, setTState] = useState(0);
    setT = setTState;
    renders.push(`${n}:${t}`);
    if (t === 1 && n === 0) {
      setN(1); // 渲染进行中插入更高优更新
    }
    useLayoutEffect(() => {
      committed.push(`${n}:${t}`);
    });
    return createElement('span', null, `${n}:${t}`);
  }

  const { container, root } = createTestRoot();
  updateContainer(createElement(App, null), root);
  await flushSyncRender();
  startTransition(() => {
    setT(1);
  });
  await waitFor(
    () => committed.includes('1:1') && rootText(container) === '1:1',
    'transition 重开后没有提交最终状态',
  );
  equal(renders.includes('0:1'), true, '被丢掉的 transition 渲染确实跑过');
  equal(committed.includes('0:1'), false, '被丢掉的 WIP 没有进入 Commit');
});

test('Scheduler 按优先级出堆，unstable_now 返回数字', async () => {
  const order: string[] = [];
  unstable_scheduleCallback(LowPriority, () => {
    order.push('low');
  });
  unstable_scheduleCallback(ImmediatePriority, () => {
    order.push('now');
  });
  await waitFor(() => order.length === 2, '两个 Scheduler 任务没有跑完');
  equal(order.join(','), 'now,low', 'Immediate 先于 Low 出堆');
  equal(typeof unstable_now(), 'number', 'unstable_now 返回当前时间');
});

test('渲染抛错时提交边界 fallback，current 树不会停在半截', async () => {
  function Boom(props: { crash: boolean }) {
    if (props.crash) {
      throw new Error('boom');
    }
    return createElement('span', null, 'ok');
  }

  const { container, root } = createTestRoot();
  updateContainer(
    createElement(
      ErrorBoundary,
      { fallback: createElement('span', null, 'fallback') },
      createElement(Boom, { crash: false }),
    ),
    root,
  );
  await flushSyncRender();
  equal(rootText(container), 'ok', '出错前提交的是正常子树');

  updateContainer(
    createElement(
      ErrorBoundary,
      { fallback: createElement('span', null, 'fallback') },
      createElement(Boom, { crash: true }),
    ),
    root,
  );
  await flushSyncRender();
  equal(rootText(container), 'fallback', '边界提交 fallback');
  equal(container.children.length, 1, '半截出错子树没有留在宿主树上');
});

test('Suspense 先提交 fallback，thenable 完成后按原 lane 重试', async () => {
  let value: string | null = null;
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  function Reader() {
    if (value == null) {
      throw promise;
    }
    return createElement('span', null, value);
  }

  const { container, root } = createTestRoot();
  updateContainer(
    createElement(
      Suspense,
      { fallback: createElement('span', null, 'loading') },
      createElement(Reader, null),
    ),
    root,
  );
  await flushSyncRender();
  equal(rootText(container), 'loading', '挂起时提交 fallback');

  value = 'done';
  resolvePromise();
  await waitFor(() => rootText(container) === 'done', 'thenable 完成后没有重试成功');
});

let failed = 0;
for (const item of tests) {
  try {
    await item.run();
    console.log(`✓ ${item.name}`);
  } catch (error) {
    failed++;
    console.error(`✗ ${item.name}`);
    console.error(error);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
const nodeProcess = (globalThis as { process?: { exit(code: number): never } }).process;
if (nodeProcess != null) {
  nodeProcess.exit(failed === 0 ? 0 : 1);
}
