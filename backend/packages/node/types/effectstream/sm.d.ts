export type BaseStfInput = any;
export type BaseStfOutput = any;

export class Stm<G = any, E = any> {
  constructor(grammar: G);
  addStateTransition(name: string, handler: (data: any) => any): this;
  processInput(input: any): any;
  keyedJsonGrammar: any;
  fullJsonGrammar: any;
}

export const builtInPrimitivesMap: any;
