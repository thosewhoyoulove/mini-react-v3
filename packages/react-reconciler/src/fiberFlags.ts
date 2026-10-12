/**
 * Render 阶段记录、Commit 阶段消费的副作用位。
 * 多种副作用可以按位或挂在同一个 Fiber 上，Mask 则把某个阶段关心的位合并起来。
 */

/** 没有副作用。 */
export const NoFlags = 0;

/** 新宿主节点需要插入，或复用节点需要移动。 */
export const Placement = 2;

/** Host props/text 要改，或函数组件有 Layout Effect 要执行。 */
export const Update = 4;

/** 父 Fiber.deletions 中有待卸载的旧子树。 */
export const ChildDeletion = 16;

/** 渲染抛错或挂起后，边界改走 fallback，不再提交出错的那半截。 */
export const DidCapture = 64;

/** Layout 阶段要写入或清空 ref。 */
export const Ref = 512;

/** 函数组件有 Passive Effect 要在后续 Scheduler 任务执行。 */
export const Passive = 2048;

/** Mutation 阶段关心的插入、更新和删除。 */
export const MutationMask = Placement | Update | ChildDeletion;

/**
 * Layout 阶段要看的副作用。
 * 官方把 useLayoutEffect 标成 Update（和 Host 的 DOM 更新共用这一位），
 * commit 时按 fiber.tag 分叉：Host 改 DOM，FunctionComponent 跑 layout effect。
 */
export const LayoutMask = Update | Ref;

/** Passive 遍历还包含删除，因为被删子树也可能需要 Effect cleanup。 */
export const PassiveMask = Passive | ChildDeletion;
