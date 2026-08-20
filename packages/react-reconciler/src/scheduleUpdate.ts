import type { Fiber } from './fiber';
import { DefaultLane, type Lane } from './fiberLanes';

let impl: ((fiber: Fiber, lane: Lane) => void) | null = null;

export function setScheduleUpdateOnFiber(
  fn: (fiber: Fiber, lane: Lane) => void,
): void {
  impl = fn;
}

export function scheduleUpdateOnFiber(
  fiber: Fiber,
  lane: Lane = DefaultLane,
): void {
  if (impl == null) {
    throw new Error('scheduleUpdateOnFiber is not initialized');
  }
  impl(fiber, lane);
}
