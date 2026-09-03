export function isConventionalTypeScriptTestPath(path: string): boolean {
  return /(?:^|\/)__tests__\//u.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
}
