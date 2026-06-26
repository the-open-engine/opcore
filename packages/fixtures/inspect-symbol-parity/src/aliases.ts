import { GreetingModel as ImportedGreetingModel, type GreetingMessage } from "@models";

export class AliasGreetingModel extends ImportedGreetingModel {}

export function buildAlias(message: GreetingMessage): AliasGreetingModel {
  return new AliasGreetingModel(message);
}

export function buildImportedAlias(message: GreetingMessage): ImportedGreetingModel {
  return new ImportedGreetingModel(message);
}
