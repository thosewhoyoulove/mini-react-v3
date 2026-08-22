export const NoFlags = 0;
export const Placement = 2;
export const Update = 4;
export const ChildDeletion = 16;
export const Passive = 2048;

export const MutationMask = Placement | Update | ChildDeletion;

/**
 * Layout 阶段要看的副作用。
 * 官方把 useLayoutEffect 标成 Update（和 Host 的 DOM 更新共用这一位），
 * commit 时按 fiber.tag 分叉：Host 改 DOM，FunctionComponent 跑 layout effect。
 */
export const LayoutMask = Update;

export const PassiveMask = Passive | ChildDeletion;
