/**
 * Lane：一次更新的优先级，用比特位表示，可以按位或合并。
 *
 * 数字越小（最低位）优先级越高，和官方 ReactFiberLane.js 同一套规则：
 *   lanes & -lanes 取出最低的置位，就是当前最高优的那一条。
 *
 * 本教学实现只保留两条，方便对照 workLoop 的 sync / concurrent 分叉：
 *   SyncLane    —— root.render / 必须马上画出来
 *   DefaultLane —— setState，走 Scheduler 时间切片
 *
 * 官方还有 InputContinuous、Transition、Idle 等十几条；读源码时把它们
 * 都当成「Default 和 Sync 之间的不同档位」即可。
 */
export type Lane = number;
export type Lanes = number;

export const NoLane: Lane = 0b00;
export const NoLanes: Lanes = 0b00;
export const SyncLane: Lane = 0b01;
export const DefaultLane: Lane = 0b10;

/**
 * 把两条（或多条）lane 并进同一个集合。按位或：哪一位曾经是 1，结果里还是 1。
 * 用来记下「又来了一条更新」，不会把已有的挤掉。
 * 例：Default 还在 pending 时又来了 Sync → 0b10 | 0b01 = 0b11。
 */
export function mergeLanes(a: Lanes, b: Lanes): Lanes {
  return a | b;
}

/**
 * 从集合里抠掉已经处理完的那一档。~toRemove 把要删的位变成 0，再 & 回去。
 * 例：刚跑完 Sync → 0b11 & ~0b01 = 0b10，pending 只剩 Default，等 commit 后再 schedule。
 */
export function removeLanes(set: Lanes, toRemove: Lanes): Lanes {
  return set & ~toRemove;
}

/**
 * 问「这堆更新里有没有某一档」。按位与有交集（结果不是 0）就返回 true。
 * 例：0b11 & 0b01 = 0b01 → pending 里有 Sync；0b10 & 0b01 = 0 → 只有 Default。
 */
export function includesSomeLane(set: Lanes, subset: Lanes): boolean {
  return (set & subset) !== NoLanes;
}

/** 取出最低置位 = 最高优先级。例：0b11 → 0b01（Sync） */
export function getHighestPriorityLane(lanes: Lanes): Lane {
  return lanes & -lanes;
}

/**
 * 这一轮该处理哪些更新。有 Sync 就只跑 Sync（高优先完成），
 * Default 留在 pendingLanes 里，commit 后再 schedule 一次。
 */
export function getNextLanes(root: { pendingLanes: Lanes }): Lanes {
  const pending = root.pendingLanes;
  if (pending === NoLanes) {
    return NoLanes;
  }
  if (includesSomeLane(pending, SyncLane)) {
    return SyncLane;
  }
  if (includesSomeLane(pending, DefaultLane)) {
    return DefaultLane;
  }
  return pending;
}

/** a 是否比 b 更紧急。NoLane 视为最低。 */
export function isHigherPriorityLane(a: Lane, b: Lane): boolean {
  if (a === NoLane) {
    return false;
  }
  if (b === NoLane) {
    return true;
  }
  return a < b;
}
