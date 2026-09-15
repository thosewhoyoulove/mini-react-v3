/**
 * Reconciler 所需的最小宿主能力集合。
 *
 * Render / Commit 只调用这些抽象操作，不直接 import DOM API。react-dom 提供
 * HTMLElement 实现；测试则提供普通对象树实现，从而证明协调算法与宿主无关。
 */
export interface HostConfig<
  Type = any,
  Props = any,
  Container = any,
  Instance = any,
  TextInstance = any,
> {
  /** Render 的 completeWork 创建一个尚未挂载的宿主元素。 */
  createInstance(type: Type, props: Props): Instance;

  /** Render 的 completeWork 创建一个尚未挂载的文本节点。 */
  createTextInstance(text: string): TextInstance;

  /** 把后代装进离屏宿主元素，或在 Commit 中追加现有节点。 */
  appendChild(parent: Instance, child: Instance | TextInstance): void;

  /** Commit 把顶层宿主节点追加到根容器。 */
  appendChildToContainer(
    container: Container,
    child: Instance | TextInstance,
  ): void;

  /** Commit 在普通宿主父节点的某个稳定兄弟之前插入或移动。 */
  insertBefore(
    parent: Instance,
    child: Instance | TextInstance,
    before: Instance | TextInstance,
  ): void;

  /** Commit 在根容器的某个稳定兄弟之前插入或移动。 */
  insertInContainerBefore(
    container: Container,
    child: Instance | TextInstance,
    before: Instance | TextInstance,
  ): void;

  /** 从普通宿主父节点删除直接孩子。 */
  removeChild(parent: Instance, child: Instance | TextInstance): void;

  /** 从根容器删除直接孩子。 */
  removeChildFromContainer(
    container: Container,
    child: Instance | TextInstance,
  ): void;

  /** Mutation 阶段把 oldProps 与 newProps 的差异应用到已有实例。 */
  commitUpdate(
    instance: Instance,
    type: Type,
    oldProps: Props,
    newProps: Props,
  ): void;

  /** Mutation 阶段修改已有文本节点的内容。 */
  commitTextUpdate(
    textInstance: TextInstance,
    oldText: string,
    newText: string,
  ): void;
}
