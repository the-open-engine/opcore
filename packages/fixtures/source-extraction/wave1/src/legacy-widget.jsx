import { GreetingCard } from "@components/GreetingCard";
import { formatGreeting } from "@models";

export class LegacyWidget {
  render() {
    return createLegacyMessage();
  }
}

export const createLegacyMessage = () => formatGreeting({ salutation: "Hello", name: "Legacy" });

export const LegacyWidgetView = () => (
  <GreetingCard message={{ salutation: "Hello", name: "Ada" }} />
);

export default function LegacyDefaultWidget() {
  return <LegacyWidgetView />;
}
