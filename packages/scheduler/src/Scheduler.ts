import { enableSchedulerDebugging } from 'shared';

/**
 * 调度器：把「现在立刻跑完整棵树」拆成「每帧只干一小段」。
 *
 * 浏览器一帧大约 16ms。如果 React 在一个任务里把大树全部 reconcile，
 * 输入和绘制都会卡住。官方做法是：
 * 1. 把工作放到宏任务里（本文件用 MessageChannel）
 * 2. 每个切片开始时设一个 deadline
 * 3. workLoop 里反复问 shouldYield()，到点就停，下一宏任务再续
 *
 * 真正的优先级在 reconciler 的 Lane，不在这里。
 * 这里只负责：按 id 排队 / 取消，以及 5ms 切片。
 * SyncLane 根本不会走进这个文件，它走 queueMicrotask。
 */

export type PriorityLevel = 1 | 2 | 3 | 4 | 5;

export const ImmediatePriority: PriorityLevel = 1;
export const UserBlockingPriority: PriorityLevel = 2;
export const NormalPriority: PriorityLevel = 3;
export const LowPriority: PriorityLevel = 4;
export const IdlePriority: PriorityLevel = 5;

type Task = {
  id: number;
  callback: (() => void) | null;
};

/** 每个切片最多工作 5ms，超时就让出主线程。官方会随帧率调整，这里写死方便理解。 */
const yieldInterval = 5;

/** 当前切片的截止时间。shouldYield 拿它和 performance.now() 比较。 */
let deadline = 0;
let nextTaskId = 1;

/**
 * 为什么用 MessageChannel，而不是 setTimeout(fn, 0)？
 * - setTimeout 最小延迟往往被浏览器夹到 4ms+，切片之间空隙大
 * - Promise/queueMicrotask 是微任务，会在绘制前把队列清空，切不出去
 * - MessageChannel 的 port.postMessage 会排一个比较及时的宏任务：
 *   当前 JS 跑完 → 浏览器可以先绘制/处理输入 → 再执行 onmessage
 *
 * 两个 port 是一对管道：往 port2 发消息，port1 的 onmessage 就会被触发。
 */
const channel = new MessageChannel();
const port = channel.port2;
const taskQueue: Task[] = [];

channel.port1.onmessage = () => {
  const task = taskQueue.shift();
  if (task == null || task.callback == null) {
    if (taskQueue.length > 0) {
      port.postMessage(null);
    }
    return;
  }

  deadline = performance.now() + yieldInterval;
  const callback = task.callback;
  task.callback = null;
  callback();

  if (taskQueue.length > 0) {
    port.postMessage(null);
  }
};

/** workLoop 每处理完一个 Fiber 就问一次：这帧时间到了没？到了就暂停。 */
export function unstable_shouldYield(): boolean {
  return performance.now() >= deadline;
}

/**
 * 预约一次并发工作。reconciler 只在 DefaultLane 时会调它。
 * priorityLevel 官方用来插入不同优先级堆，这里仍是 FIFO；
 * 档位切换靠 reconciler cancel 掉旧 task 再约新的。
 */
export function unstable_scheduleCallback(
  _priorityLevel: PriorityLevel,
  callback: () => void,
): number {
  const id = nextTaskId++;
  if (enableSchedulerDebugging) {
    callback();
    return id;
  }

  taskQueue.push({ id, callback });
  port.postMessage(null);
  return id;
}

/** 按 task id 取消。SyncLane 插队时会把尚未执行的 DefaultLane 回调作废。 */
export function unstable_cancelCallback(id: number): void {
  for (let i = 0; i < taskQueue.length; i++) {
    if (taskQueue[i].id === id) {
      taskQueue[i].callback = null;
      return;
    }
  }
}
