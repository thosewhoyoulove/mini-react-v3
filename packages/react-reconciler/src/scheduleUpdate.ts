import type { Fiber } from './fiber';
import { DefaultLane, type Lane } from './fiberLanes';

/**
 * Hooks 到 workLoop 的依赖接缝。
 *
 * hooks.ts 可以创建 dispatch，但不能直接 import workLoop，否则容易形成循环依赖。
 * workLoop 初始化模块时注入真实实现，之后 setState 只经这里转发。
 */

/** workLoop 注入的 scheduleUpdateOnFiberImpl。 */
let impl: ((fiber: Fiber, lane: Lane) => void) | null = null;

/** 模块初始化时登记真正的调度入口。 */
export function setScheduleUpdateOnFiber(
  fn: (fiber: Fiber, lane: Lane) => void,
): void {
  impl = fn;
}

/** 从 Hook dispatch 发起更新；用户 setState 默认属于 DefaultLane。 */
export function scheduleUpdateOnFiber(
  fiber: Fiber,
  lane: Lane = DefaultLane,
): void {
  if (impl == null) {
    throw new Error('scheduleUpdateOnFiber is not initialized');
  }
  impl(fiber, lane);
}
