import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GreetingModel, formatGreeting } from "@models";
import { GreetingCard } from "@components/GreetingCard";
import { add } from "@math";

describe("GreetingCard", () => {
  it("renders greeting cards", () => {
    const model = new GreetingModel({ salutation: "Hello", name: "Ada" });
    assert.equal(model.render(), "Hello, Ada");
    assert.equal(formatGreeting({ salutation: "Hi", name: "Grace" }), "Hi, Grace");
    assert.equal(add(1, 2), 3);
    GreetingCard({ message: { salutation: "Welcome", name: "Lin" } });
  });
});
