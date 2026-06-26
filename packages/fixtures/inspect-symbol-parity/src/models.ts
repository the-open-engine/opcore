export class GreetingModel implements Renderable {
  constructor(private readonly message: GreetingMessage) {}

  render(): string {
    return formatGreeting(this.message);
  }
}

export interface Renderable {
  render(): string;
}

export type GreetingMessage = {
  salutation: string;
  name: string;
};

export class FriendlyGreetingModel extends GreetingModel {}

export function formatGreeting(message: GreetingMessage): string {
  return `${message.salutation}, ${message.name}`;
}

export function makeGreetingModel(message: GreetingMessage): GreetingModel {
  return new GreetingModel(message);
}

export async function formatGreetingAsync<T extends GreetingMessage = GreetingMessage>(
  message: T,
  punctuation = "!"
): Promise<string> {
  return `${formatGreeting(message)}${punctuation}`;
}

export const makeGreetingFormatter = (prefix?: string): ((message: GreetingMessage) => string) => {
  return (message: GreetingMessage) => `${prefix ? `${prefix}: ` : ""}${formatGreeting(message)}`;
};
