import { GreetingModel, type GreetingMessage, type Renderable } from "@models";

export interface AsyncRenderable extends Renderable {
  renderAsync(): Promise<string>;
}

export abstract class BasePresenter implements AsyncRenderable {
  constructor(protected readonly model: GreetingModel) {}

  render(): string {
    return this.model.render();
  }

  async renderAsync(): Promise<string> {
    return this.render();
  }
}

export class FriendlyPresenter extends BasePresenter {
  static fromMessage(message: GreetingMessage): FriendlyPresenter {
    return new FriendlyPresenter(new GreetingModel(message));
  }
}

export class CompactPresenter extends BasePresenter {}

export function createPresenter(message: GreetingMessage): AsyncRenderable {
  return FriendlyPresenter.fromMessage(message);
}
