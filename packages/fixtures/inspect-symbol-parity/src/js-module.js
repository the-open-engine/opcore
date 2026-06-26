export class JsGreeter {
  constructor(name) {
    this.name = name;
  }

  greet() {
    return `Hello, ${this.name}`;
  }
}

export function makeJsGreeter(name) {
  return new JsGreeter(name);
}

export const jsGreeting = new JsGreeter("Lin");
