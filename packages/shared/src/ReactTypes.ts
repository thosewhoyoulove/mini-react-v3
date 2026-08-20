export type Type = any;
export type Key = string | null;
export type Ref = any;

export interface Props {
  [key: string]: any;
  children?: any;
}

export interface ReactElement {
  $$typeof: symbol | number;
  type: Type;
  key: Key;
  ref: Ref;
  props: Props;
}
