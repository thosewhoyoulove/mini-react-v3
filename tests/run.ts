import { createElement, useEffect, useLayoutEffect, useState } from 'react';
import {
  createContainer,
  updateContainer,
  type HostConfig,
} from 'react-reconciler';
import { hostConfig as domHostConfig } from '../packages/react-dom/src/hostConfig';

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
    'render 1',
    'deps 不变时只重新 render，不应执行 Effect cleanup/create',
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
  const next = {
    className: 'after',
    disabled: false,
    onClick: nextClick,
  };

  domHostConfig.commitUpdate(
    element as unknown as HTMLElement,
    'button',
    previous,
    next,
  );

  equal(element.attributes.get('class'), 'after', 'className 应映射到 class');
  equal(element.attributes.has('disabled'), false, 'false 布尔属性应删除');
  equal(element.listeners.get('click'), nextClick as EventListener, '旧监听器应替换为新监听器');
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
