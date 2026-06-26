import { GreetingModel, type GreetingMessage } from "@models";

export function describeGreeting(model: GreetingModel): string;
export function describeGreeting(message: GreetingMessage): string;
export function describeGreeting(input: GreetingModel | GreetingMessage): string {
  if (input instanceof GreetingModel) return input.render();
  return `${input.salutation}, ${input.name}`;
}

export const overloadedText = describeGreeting(new GreetingModel({ salutation: "Hi", name: "Grace" }));
