export function JsxWidget(props) {
  return <span>{props.label}</span>;
}

export const JsxUsage = <JsxWidget label="Ready" />;
