export const NoFlags = 0;
export const Placement = 2;
export const Update = 4;
export const ChildDeletion = 16;
export const Passive = 2048;

export const MutationMask = Placement | Update | ChildDeletion;
export const PassiveMask = Passive | ChildDeletion;
