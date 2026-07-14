export async function loadFrom(specifier: string) {
  return import(specifier);
}
