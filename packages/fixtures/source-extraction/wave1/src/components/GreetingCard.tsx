import { GreetingModel, type GreetingMessage } from "@models";
import { add } from "../math.js";

export function GreetingCard({ message }: { message: GreetingMessage }) {
  const model = new GreetingModel(message);
  return (
    <section data-total={add(1, 2)}>
      {model.render()}
    </section>
  );
}
