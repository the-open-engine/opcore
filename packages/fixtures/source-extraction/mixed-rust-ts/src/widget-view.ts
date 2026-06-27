export interface WidgetView {
  label: string;
  source: "typescript";
}

export function describeWidget(name: string): WidgetView {
  return { label: `widget:${name}`, source: "typescript" };
}

export function renderWidgetLabel(name: string): string {
  return describeWidget(name).label;
}
