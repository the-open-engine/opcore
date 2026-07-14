export async function loadDynamic() {
  return import("./dynamic-target.js");
}
