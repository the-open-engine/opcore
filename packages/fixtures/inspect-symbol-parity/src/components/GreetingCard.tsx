import { GreetingModel, type GreetingMessage, type Renderable } from "@models";

export interface CardRenderable extends Renderable {
  cardTitle: string;
}

export class GreetingCardModel extends GreetingModel implements CardRenderable {
  readonly cardTitle = "Greeting";
}

export function GreetingCard({ message }: { message: GreetingMessage }) {
  const model = new GreetingCardModel(message);
  return <section>{model.render()}</section>;
}

export function GreetingCardPreview() {
  return <GreetingCard message={{ salutation: "Hello", name: "Ada" }} />;
}
