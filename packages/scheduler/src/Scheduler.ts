import { enableSchedulerDebugging } from 'shared';

/**
 * 调度器：把「现在立刻跑完整棵树」拆成「每帧只干一小段」。
 *
 * 任务按优先级放进最小堆，堆顶是最小的 priorityLevel，同档再比 startTime。
 * MessageChannel 只负责拿到一个宏任务：onmessage 弹出堆顶的一条 callback。
 *
 *   heap[0] = 当前最紧急、最早入队的任务
 *   port.postMessage → 宏任务 → pop → callback → 还有任务就再 postMessage
 *
 * SyncLane 不进这个文件，它走 queueMicrotask。
 * shouldYield 仍是 5ms：堆决定先跑谁，时间片决定这一条要不要让出主线程。
 */

/** Scheduler API 接受的五档优先级。数字越小越先出堆。 */
export type PriorityLevel = 1 | 2 | 3 | 4 | 5;

/** 最高档。当前 reconciler 的 SyncLane 不经过 Scheduler。 */
export const ImmediatePriority: PriorityLevel = 1;

/** 连续输入。比 Normal 先出堆。 */
export const UserBlockingPriority: PriorityLevel = 2;

/** DefaultLane 使用的普通优先级。 */
export const NormalPriority: PriorityLevel = 3;

/** TransitionLane 使用的低优先级。高优任务会先被弹出。 */
export const LowPriority: PriorityLevel = 4;

/** 空闲优先级。五档里最后执行。 */
export const IdlePriority: PriorityLevel = 5;

/** 最小堆里的一项工作。 */
type Task = {
  /** 单调递增任务号，reconciler 用它取消尚未开始的回调。 */
  id: number;

  /** null 表示已执行或已取消。弹出时直接丢掉。 */
  callback: (() => void) | null;

  /** 越小越紧急。先于 startTime 比较。 */
  priorityLevel: PriorityLevel;

  /** unstable_now() 当时的时间。同优先级按入队先后。 */
  startTime: number;
};

/** 每个切片最多工作 5ms，超时就让出主线程。 */
const yieldInterval = 5;

/** 当前切片的截止时间。shouldYield 拿它和 unstable_now() 比较。 */
let deadline = 0;

/** 下一条任务的 id。 */
let nextTaskId = 1;

/**
 * 为什么用 MessageChannel，而不是 setTimeout(fn, 0)？
 * - setTimeout 最小延迟往往被浏览器夹到 4ms+，切片之间空隙大
 * - Promise/queueMicrotask 是微任务，会在绘制前把队列清空，切不出去
 * - MessageChannel 的 port.postMessage 会排一个比较及时的宏任务
 */
/** 宏任务通道。接收端每次只消费堆顶一条 callback。 */
const channel = new MessageChannel();

/** 发送端：postMessage 只负责约一个新的宏任务。 */
const port = channel.port2;

/** 优先级最小堆。下标 0 是下一个要跑的任务。 */
const taskQueue: Task[] = [];

/** 当前时间。测试和 shouldYield 都用它，避免散落 performance.now。 */
export function unstable_now(): number {
  return performance.now();
}

/** a 是否应该比 b 更靠近堆顶。 */
function isLess(a: Task, b: Task): boolean {
  if (a.priorityLevel !== b.priorityLevel) {
    return a.priorityLevel < b.priorityLevel;
  }
  return a.startTime < b.startTime;
}

/** 新任务从末尾冒到正确的一层。 */
function siftUp(index: number): void {
  const task = taskQueue[index];
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!isLess(task, taskQueue[parent])) {
      break;
    }
    taskQueue[index] = taskQueue[parent]; // 父节点下沉，空位继续上移
    index = parent;
  }
  taskQueue[index] = task;
}

/** 堆顶被取走后，把末尾补上再下沉。比较对象始终是正在下沉的 task。 */
function siftDown(index: number): void {
  const task = taskQueue[index];
  const length = taskQueue.length;
  while (true) {
    const left = index * 2 + 1;
    if (left >= length) {
      break;
    }
    let next = left;
    const right = left + 1;
    if (right < length && isLess(taskQueue[right], taskQueue[left])) {
      next = right; // 较小的那个孩子
    }
    if (!isLess(taskQueue[next], task)) {
      break; // 孩子不比 task 更紧急，停在这一层
    }
    taskQueue[index] = taskQueue[next];
    index = next;
  }
  taskQueue[index] = task;
}

/**
 * 取出堆顶。callback 已是 null 的取消项继续弹，不另开宏任务。
 *
 * 1. 空堆返回 null
 * 2. 把最后一格补到堆顶并下沉
 * 3. 跳过已取消的任务
 */
function popTask(): Task | null {
  while (taskQueue.length > 0) {
    const first = taskQueue[0];
    const last = taskQueue.pop() as Task; // 1
    if (taskQueue.length > 0) {
      taskQueue[0] = last; // 2
      siftDown(0);
    }
    if (first.callback != null) {
      return first; // 3
    }
  }
  return null;
}

channel.port1.onmessage = () => {
  const task = popTask();
  if (task == null || task.callback == null) {
    return;
  }

  deadline = unstable_now() + yieldInterval;
  const callback = task.callback;
  task.callback = null;
  callback();

  if (taskQueue.length > 0) {
    port.postMessage(null); // 还有任务：再约一个宏任务，而不是在这条里排空
  }
};

/** workLoop 每处理完一个 Fiber 就问一次：这帧时间到了没？到了就暂停。 */
export function unstable_shouldYield(): boolean {
  return unstable_now() >= deadline;
}

/**
 * 按优先级把 callback 放进最小堆。
 *
 * 1. 调试开关打开时立即执行，测试宿主不必等宏任务
 * 2. 记录 id、优先级和入队时间
 * 3. 入堆后 postMessage，让 MessageChannel 之后弹出堆顶
 */
export function unstable_scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: () => void,
): number {
  const id = nextTaskId++;
  if (enableSchedulerDebugging) {
    callback(); // 1
    return id;
  }

  const task: Task = {
    id,
    callback,
    priorityLevel,
    startTime: unstable_now(),
  }; // 2
  taskQueue.push(task);
  siftUp(taskQueue.length - 1);
  port.postMessage(null); // 3
  return id;
}

/** 按 task id 把 callback 置空。堆里的空位等弹出时丢掉。 */
export function unstable_cancelCallback(id: number): void {
  for (let i = 0; i < taskQueue.length; i++) {
    if (taskQueue[i].id === id) {
      taskQueue[i].callback = null;
      return;
    }
  }
}
