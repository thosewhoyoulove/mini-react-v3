import {
  ErrorBoundary,
  Fragment,
  Suspense,
  createContext,
  createElement,
  memo,
  startTransition,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  configureDebug,
  type DebugLogEntry,
  type DebugLogLevel,
} from 'shared';

/**
 * 教学 demo：把一条很长的功能演示拆成可以独立观察的实验。
 *
 * 1. StateDemo：观察函数式更新如何进入同一条 Hook 队列
 * 2. ListDemo：观察 key 如何决定复用、移动、新建和删除
 * 3. EffectsDemo：观察 Layout 与 Passive 的 create / cleanup 时序
 * 4. BailoutDemo：父更新跳过子函数；子更新会把父函数拉回来
 * 5. ContextDemo：value 不变时消费者被跳过；transition 可被高优更新丢掉
 * 6. BoundaryDemo：错误边界、Suspense fallback，以及容器上的 click 委托
 * 7. TimeSliceDemo：观察并发切片执行的 work unit 和 shouldYield
 * 8. DoubleBufferDemo：观察 current、workInProgress 与 alternate 的切换
 */

/** 调试面板最多保留的日志条数，避免长时间点击导致页面无限增长。 */
const maxDebugEntries = 120;

/** 面板当前保留的结构化事件；Fiber 和 DOM 都不放进这里。 */
const debugEntries: DebugLogEntry[] = [];

/** Demo 用的根引用，只用于读取可序列化的调试快照，不参与调和。 */
let demoRoot: ReturnType<typeof createRoot> | null = null;

/** 把一条结构化事件压缩成面板中的单行文本。 */
function formatDebugEntry(entry: DebugLogEntry): string {
  const component = entry.component ?? entry.fiberTag ?? '-';
  const updateId = entry.updateId == null ? '-' : String(entry.updateId);
  const lane = entry.lane == null ? '-' : String(entry.lane);
  const slice =
    entry.workUnits == null
      ? ''
      : ` | work=${entry.workUnits} | yield=${entry.didYield ? 'yes' : 'no'}`;
  return `${entry.phase} | ${component} | update#${updateId} | lane=${lane}${slice} | ${entry.message}`;
}

/** 把 Logger 事件追加到页面外置的原生日志列表，不触发 React 自身更新。 */
function appendDebugEntry(entry: DebugLogEntry): void {
  debugEntries.push(entry);
  if (debugEntries.length > maxDebugEntries) {
    debugEntries.shift();
  }
  if (entry.phase === 'render' && entry.workUnits != null) {
    const metrics = document.getElementById('slice-metrics');
    if (metrics != null) {
      metrics.textContent =
        `最近切片：${entry.workUnits} 个 work unit，shouldYield：${entry.didYield ? '触发' : '未触发'}`;
    }
  }
  const log = document.getElementById('debug-log');
  if (log == null) {
    return;
  }
  const item = document.createElement('li');
  item.textContent = formatDebugEntry(entry);
  log.appendChild(item);
  while (log.children.length > maxDebugEntries) {
    log.firstElementChild?.remove();
  }
  log.scrollTop = log.scrollHeight;
}

/** 初始化 Debug Logger 面板，并把 Fiber Inspector 绑定到当前 DOM 根。 */
function setupDebugPanel(root: ReturnType<typeof createRoot>): void {
  const levelSelect = document.getElementById('debug-level') as HTMLSelectElement | null;
  const status = document.getElementById('debug-status');
  const clearButton = document.getElementById('debug-clear');
  const inspectButton = document.getElementById('debug-inspect');
  const tree = document.getElementById('debug-tree');

  const setStatus = (message: string): void => {
    if (status != null) {
      status.textContent = message;
    }
  };

  const currentLevel = (levelSelect?.value ?? 'off') as DebugLogLevel;
  configureDebug({ level: currentLevel, sink: appendDebugEntry });
  setStatus(`日志：${currentLevel}`);

  levelSelect?.addEventListener('change', () => {
    const level = levelSelect.value as DebugLogLevel;
    configureDebug({ level });
    setStatus(`日志：${level}`);
  });

  clearButton?.addEventListener('click', () => {
    debugEntries.length = 0;
    const log = document.getElementById('debug-log');
    if (log != null) {
      log.textContent = '';
    }
    if (tree != null) {
      tree.textContent = '';
    }
    setStatus('日志已清空');
  });

  inspectButton?.addEventListener('click', () => {
    if (tree != null) {
      tree.textContent = root.formatFiberTree();
    }
    setStatus('已刷新 current Fiber 树');
  });
}

/** 下一次追加列表项时使用的稳定编号，避免删除后产生重复 key。 */
let nextItemId = 4;

/** 把 Effect 阶段写进页面，同时保留控制台输出供 DevTools 对照。 */
function recordEffect(message: string): void {
  console.log(`[effect] ${message}`);
  const log = document.getElementById('effect-log');
  if (log == null) {
    return;
  }
  const item = document.createElement('li');
  item.textContent = message;
  log.appendChild(item);
}

/**
 * 状态实验。
 *
 * `+3（函数式）` 在同一个事件里连续入队三条 action。它们共享一次
 * DefaultLane 调度，updateState 再按环形队列的插入顺序得到最终结果。
 */
function StateDemo() {
  const [count, setCount] = useState(0);

  return createElement(
    'section',
    { className: 'card' },
    createElement('h2', null, '1. State 与更新队列'),
    createElement('p', { className: 'value' }, 'count: ' + count),
    createElement(
      'div',
      { className: 'row' },
      createElement(
        'button',
        { onClick: () => setCount((value) => value + 1) },
        '+1',
      ),
      createElement(
        'button',
        {
          onClick: () => {
            setCount((value) => value + 1);
            setCount((value) => value + 1);
            setCount((value) => value + 1);
          },
        },
        '+3（函数式）',
      ),
      createElement('button', { onClick: () => setCount(0) }, 'reset'),
    ),
    createElement(
      'p',
      { className: 'hint' },
      '断点建议：dispatchSetState → scheduleUpdateOnFiberImpl → updateState',
    ),
  );
}

/**
 * 列表实验。
 *
 * 每一项用稳定文本作为 key。reverse 会复用并移动既有 DOM；add 会新建；
 * remove first 会把旧 Fiber 记入 deletions，等 Mutation 阶段统一删除。
 */
function ListDemo() {
  const [items, setItems] = useState(['A', 'B', 'C']);

  return createElement(
    'section',
    { className: 'card' },
    createElement('h2', null, '2. Keyed 列表 Diff'),
    createElement(
      'div',
      { className: 'row' },
      createElement(
        'button',
        {
          onClick: () => {
            const item = `item-${nextItemId++}`;
            setItems((list) => list.concat(item));
          },
        },
        'add',
      ),
      createElement(
        'button',
        { onClick: () => setItems((list) => list.slice().reverse()) },
        'reverse',
      ),
      createElement(
        'button',
        { onClick: () => setItems((list) => list.slice(1)) },
        'remove first',
      ),
    ),
    createElement(
      'ul',
      { className: 'chips' },
      ...items.map((item) => createElement('li', { key: item }, item)),
    ),
    createElement(
      'p',
      { className: 'hint' },
      '断点建议：reconcileChildrenArray → placeChild → commitPlacement',
    ),
  );
}

/** 同时注册两种 Effect，让日志直接显示它们分别落在哪个阶段。 */
function EffectTarget(props: { value: number }) {
  useLayoutEffect(() => {
    const visibleValue = document.querySelector('[data-effect-value]')?.textContent;
    recordEffect(`layout create ${props.value}（DOM=${visibleValue}）`);
    return () => recordEffect(`layout cleanup ${props.value}`);
  }, [props.value]);

  useEffect(() => {
    document.title = `effect: ${props.value}`;
    recordEffect(`passive create ${props.value}`);
    return () => {
      document.title = 'Mini React Lab';
      recordEffect(`passive cleanup ${props.value}`);
    };
  }, [props.value]);

  return createElement(
    'p',
    { className: 'value', 'data-effect-value': true },
    'effect value: ' + props.value,
  );
}

/**
 * Effect 实验控制器。
 *
 * `next value` 触发依赖变化，`unmount/mount` 触发整棵函数组件的卸载与重建。
 * 日志区不由 React 生成子项，专门承接 Effect 这种命令式外部操作。
 */
function EffectsDemo() {
  const [value, setValue] = useState(0);
  const [visible, setVisible] = useState(true);

  return createElement(
    'section',
    { className: 'card' },
    createElement('h2', null, '3. Layout / Passive Effect'),
    createElement(
      'div',
      { className: 'row' },
      createElement(
        'button',
        { onClick: () => setValue((current) => current + 1) },
        'next value',
      ),
      createElement(
        'button',
        { onClick: () => setVisible((current) => !current) },
        visible ? 'unmount' : 'mount',
      ),
      createElement(
        'button',
        {
          onClick: () => {
            const log = document.getElementById('effect-log');
            if (log != null) {
              log.textContent = '';
            }
          },
        },
        'clear log',
      ),
    ),
    visible ? createElement(EffectTarget, { value }) : null,
    createElement('ol', { id: 'effect-log', className: 'log' }),
    createElement(
      'p',
      { className: 'hint' },
      'Layout 在同步 Commit 中运行；Passive 由 Scheduler 放到后续宏任务。',
    ),
  );
}

/** 子函数执行次数。bailout 成功时，父组件重渲染也不会增加它。 */
let bailoutChildRenders = 0;

/** 被跳过的子组件。父级只改自己的 state 时，这里不应再执行。 */
function BailoutChild() {
  bailoutChildRenders += 1;
  const [n, setN] = useState(0);
  const ref = useRef(0);
  ref.current = n;
  return createElement(
    Fragment,
    null,
    createElement(
      'button',
      { onClick: () => setN((value) => value + 1) },
      'child ' + n,
    ),
    createElement('span', null, ' ref ' + ref.current),
  );
}

/**
 * 剪枝实验。
 *
 * parent +1 只改父 state。子组件 props 是空对象，子树也没有 lane，beginWork 直接克隆孩子。
 * child +1 会把 lane 标到父级 childLanes 上，父函数必须重跑。
 */
function BailoutDemo() {
  const [tick, setTick] = useState(0);
  return createElement(
    'section',
    { className: 'card' },
    createElement('h2', null, '4. Bailout、ref 与 Fragment'),
    createElement(
      'p',
      { className: 'value' },
      'parent ' + tick + ' / child renders ' + bailoutChildRenders,
    ),
    createElement(
      'div',
      { className: 'row' },
      createElement(
        'button',
        { onClick: () => setTick((value) => value + 1) },
        'parent +1',
      ),
      createElement(BailoutChild, null),
    ),
    createElement(
      'p',
      { className: 'hint' },
      '断点建议：canSkipUpdate → cloneChildFibers。parent +1 时 child renders 停在 1。',
    ),
  );
}

/** 给消费者和 memo 子树共用的值。 */
const DemoContext = createContext('alpha');

/** memo 内部函数的执行次数。props 没变时应保持不变。 */
let memoRenders = 0;

/** 只有 n 变化才进入。tick 变化时 compare 通过，直接 bailout。 */
const MemoReadout = memo(function MemoReadout(props: { n: number }) {
  memoRenders += 1;
  return createElement('span', null, ' memo ' + props.n + ' / runs ' + memoRenders);
});

/** 读 context。value 不变时，即使父组件重渲染，这里也会被跳过。 */
function ContextReadout() {
  const value = useContext(DemoContext);
  const renders = useRef(0);
  renders.current += 1;
  return createElement(
    'span',
    null,
    ' context ' + value + ' / runs ' + renders.current,
  );
}

/**
 * 边界与优先级实验。
 *
 * 改 context 会禁止消费者 bailout。startTransition 里的 setText 走 TransitionLane；
 * 若渲染过程中再 setUrgent，进行中的 transition WIP 会被丢掉。
 */
function ContextDemo() {
  const [tick, setTick] = useState(0);
  const [value, setValue] = useState('alpha');
  const [text, setText] = useState('idle');
  const [urgent, setUrgent] = useState(0);
  return createElement(
    'section',
    { className: 'card' },
    createElement('h2', null, '5. Context、memo 与 transition'),
    createElement(
      'p',
      { className: 'value' },
      'tick ' + tick + ' / urgent ' + urgent + ' / ' + text,
    ),
    createElement(
      DemoContext.Provider,
      { value },
      createElement(ContextReadout, null),
    ),
    createElement(MemoReadout, { n: urgent }),
    createElement(
      'div',
      { className: 'row' },
      createElement(
        'button',
        { onClick: () => setTick((item) => item + 1) },
        'parent +1',
      ),
      createElement(
        'button',
        {
          onClick: () => setValue((item) => (item === 'alpha' ? 'beta' : 'alpha')),
        },
        'toggle context',
      ),
      createElement(
        'button',
        {
          onClick: () => {
            startTransition(() => {
              setText('transition');
            });
            setUrgent((item) => item + 1);
          },
        },
        'transition + urgent',
      ),
    ),
    createElement(
      'p',
      { className: 'hint' },
      '断点建议：hasContextChanged、updateMemoComponent、shouldRestartCurrentRender。',
    ),
  );
}

/** 点击次数。委托路径上每次点击只应加一。 */
let delegatedClicks = 0;

/** 子组件抛错时，边界改提交 fallback。 */
function Boom(props: { crash: boolean }) {
  if (props.crash) {
    throw new Error('demo boundary');
  }
  return createElement('span', null, 'child ok');
}

/** 值还没到就抛出 thenable，Suspense 提交 fallback。 */
function SuspendedReadout(props: { text: string | null }) {
  if (props.text == null) {
    throw new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
  }
  return createElement('span', null, props.text);
}

/**
 * 失败与挂起实验。
 *
 * 错误边界和 Suspense 都是渲染中断后的第二次 beginWork。
 * click 只在容器上监听一次，再按 parentNode 找到按钮上的处理函数。
 */
function BoundaryDemo() {
  const [crash, setCrash] = useState(false);
  const [text, setText] = useState<string | null>('idle');
  const [clicks, setClicks] = useState(0);
  return createElement(
    'section',
    { className: 'card' },
    createElement('h2', null, '6. 错误边界、Suspense 与事件委托'),
    createElement(
      ErrorBoundary,
      { fallback: createElement('span', null, 'fallback') },
      createElement(Boom, { crash }),
    ),
    createElement(
      Suspense,
      { fallback: createElement('span', null, ' loading') },
      createElement(SuspendedReadout, { text }),
    ),
    createElement(
      'div',
      { className: 'row' },
      createElement(
        'button',
        { onClick: () => setCrash((value) => !value) },
        crash ? 'recover' : 'crash',
      ),
      createElement(
        'button',
        {
          onClick: () => {
            setText(null);
            setTimeout(() => setText('done'), 400);
          },
        },
        'suspend',
      ),
      createElement(
        'button',
        {
          onClick: () => {
            delegatedClicks += 1;
            setClicks(delegatedClicks);
          },
        },
        'delegated click ' + clicks,
      ),
    ),
    createElement(
      'p',
      { className: 'hint' },
      '断点建议：unwindWork、dispatchDelegatedClick。点击按钮只增加一次。',
    ),
  );
}

/** 一个刻意带有少量计算的子组件，让每个 Fiber 更容易在时间片中被观察。 */
function SliceItem(props: { index: number; revision: number }) {
  let checksum = 0;
  for (let step = 0; step < 18000; step += 1) {
    checksum = (checksum + step + props.index + props.revision) & 255;
  }
  return createElement('li', null, `item ${props.index}: ${checksum}`);
}

/**
 * 时间切片实验。
 *
 * 1. 点击按钮给本组件入队 DefaultLane 更新
 * 2. 重新生成一组带 revision 的子组件，确保它们实际执行
 * 3. Scheduler 在 work unit 之间检查 shouldYield，Debug Logger 记录每拍数量
 * 4. 页面保持可交互；root.render 首屏仍走 SyncLane，不会进入这条路径
 */
function TimeSliceDemo() {
  const [revision, setRevision] = useState(0);
  const items = Array.from({ length: 120 }, (_, index) => index + 1);
  return createElement(
    'section',
    { className: 'card' },
    createElement('h2', null, '7. Scheduler 时间切片'),
    createElement(
      'div',
      { className: 'row' },
      createElement(
        'button',
        { onClick: () => setRevision((value) => value + 1) },
        '重新计算 120 个组件',
      ),
    ),
    createElement('p', { id: 'slice-metrics', className: 'value' }, '尚未执行并发切片'),
    createElement(
      'ul',
      { className: 'chips' },
      ...items.map((index) =>
        createElement(SliceItem, { index, revision, key: index }),
      ),
    ),
    createElement(
      'p',
      { className: 'hint' },
      '先把日志切到 trace，再点击按钮；日志中的 render 记录显示每拍 work unit 和 shouldYield。',
    ),
  );
}

/** 把当前根的可序列化双缓冲快照写进实验卡片。 */
function writeDoubleBufferSnapshot(label: string): void {
  const panel = document.getElementById('double-buffer-state');
  if (panel == null || demoRoot == null) {
    return;
  }
  const state = demoRoot.inspectFiberRootState();
  panel.textContent = [
    label,
    `current root: ${state.currentRootId}`,
    `workInProgress root: ${state.workInProgressRootId ?? 'null（当前没有进行中的 Render）'}`,
    `current.alternate: ${state.currentAlternateId ?? 'null（尚未 clone）'}`,
    `WIP active: ${state.isWorkInProgressActive ? 'yes' : 'no'}`,
  ].join('\n');
}

/**
 * 双缓冲实验。
 *
 * 1. 点击按钮前读取 current，代表屏幕上已经提交的树
 * 2. setState 让 reconciler 创建或复用 alternate 作为 WIP
 * 3. Layout 阶段再次读取，展示 Commit 后 current 已经切换
 * 4. 对比两个 root 身份，理解“改 WIP、提交后换 current”的关系
 */
function DoubleBufferDemo() {
  const [version, setVersion] = useState(0);
  useLayoutEffect(() => {
    writeDoubleBufferSnapshot('Commit 后');
  }, [version]);
  return createElement(
    'section',
    { className: 'card' },
    createElement('h2', null, '8. current / workInProgress 双缓冲'),
    createElement('p', { className: 'value' }, `version: ${version}`),
    createElement(
      'button',
      {
        onClick: () => {
          writeDoubleBufferSnapshot('更新前：current 仍指向已提交树');
          setVersion((value) => value + 1);
        },
      },
      '执行一次更新',
    ),
    createElement('pre', { id: 'double-buffer-state', className: 'debug-tree' }, '等待首屏 Commit'),
    createElement(
      'p',
      { className: 'hint' },
      '首次更新会建立 alternate；后续更新复用两格 Fiber，Commit 成功后 root.current 指向刚完成的 WIP。',
    ),
  );
}

/** 页面入口：八张卡片共用同一个 FiberRoot，但各自维护独立 Hook 链表。 */
function App() {
  return createElement(
    'main',
    { className: 'app' },
    createElement(
      'header',
      null,
      createElement('p', { className: 'eyebrow' }, 'mini-react source lab'),
      createElement('h1', null, '从交互追踪一次 React 更新'),
      createElement(
        'p',
        { className: 'intro' },
        '打开 DevTools，在提示的函数处打断点；每张卡片只验证一条源码主线。',
      ),
    ),
    createElement(StateDemo, null),
    createElement(ListDemo, null),
    createElement(EffectsDemo, null),
    createElement(BailoutDemo, null),
    createElement(ContextDemo, null),
    createElement(BoundaryDemo, null),
    createElement(TimeSliceDemo, null),
    createElement(DoubleBufferDemo, null),
  );
}

/** ReactDOM 根容器。 */
const container = document.getElementById('root');
if (container == null) {
  throw new Error('Root container #root was not found');
}

const root = createRoot(container);
demoRoot = root;
setupDebugPanel(root);
root.render(createElement(App, null));
