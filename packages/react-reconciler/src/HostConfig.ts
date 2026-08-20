export interface HostConfig<
  Type = any,
  Props = any,
  Container = any,
  Instance = any,
  TextInstance = any,
> {
  createInstance(type: Type, props: Props): Instance;
  createTextInstance(text: string): TextInstance;
  appendChild(parent: Instance, child: Instance | TextInstance): void;
  appendChildToContainer(
    container: Container,
    child: Instance | TextInstance,
  ): void;
  insertBefore(
    parent: Instance,
    child: Instance | TextInstance,
    before: Instance | TextInstance,
  ): void;
  insertInContainerBefore(
    container: Container,
    child: Instance | TextInstance,
    before: Instance | TextInstance,
  ): void;
  removeChild(parent: Instance, child: Instance | TextInstance): void;
  removeChildFromContainer(
    container: Container,
    child: Instance | TextInstance,
  ): void;
  commitUpdate(
    instance: Instance,
    type: Type,
    oldProps: Props,
    newProps: Props,
  ): void;
  commitTextUpdate(
    textInstance: TextInstance,
    oldText: string,
    newText: string,
  ): void;
}
