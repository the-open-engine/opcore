export interface Renderable {
  render(): string;
}

export type GreetingMessage = {
  salutation: string;
  name: string;
};

export class GreetingModel implements Renderable {
  constructor(private readonly message: GreetingMessage) {}

  render(): string {
    return formatGreeting(this.message);
  }
}

export class FriendlyGreetingModel extends GreetingModel implements Renderable {}

export function formatGreeting(message: GreetingMessage): string {
  return `${message.salutation}, ${message.name}`;
}

export function makeGreetingModel(message: GreetingMessage): GreetingModel {
  return new GreetingModel(message);
}

const defaultMessage: GreetingMessage = {
  salutation: "Hello",
  name: "Default"
};

export const defaultGreetingModel = makeGreetingModel(defaultMessage);

class InternalGreetingModel extends GreetingModel {}
