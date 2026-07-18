export interface ValidationRunResource {
  dispose: () => void | Promise<void>;
}

export interface ValidationRunResources {
  getOrCreate: <T extends ValidationRunResource>(
    key: PropertyKey,
    create: () => T | Promise<T>
  ) => Promise<T>;
  dispose: () => Promise<void>;
}

export function createValidationRunResources(): ValidationRunResources {
  const entries = new Map<PropertyKey, Promise<ValidationRunResource>>();
  let disposed = false;

  return {
    async getOrCreate<T extends ValidationRunResource>(
      key: PropertyKey,
      create: () => T | Promise<T>
    ): Promise<T> {
      if (disposed) throw new Error("Validation run resources are already disposed");
      const existing = entries.get(key);
      if (existing !== undefined) return existing as Promise<T>;

      const pending = Promise.resolve().then(create);
      entries.set(key, pending);
      try {
        return await pending;
      } catch (error) {
        if (entries.get(key) === pending) entries.delete(key);
        throw error;
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      let firstError: unknown;
      for (const pending of [...entries.values()].reverse()) {
        try {
          const resource = await pending;
          await resource.dispose();
        } catch (error) {
          firstError ??= error;
        }
      }
      entries.clear();
      if (firstError !== undefined) throw firstError;
    }
  };
}
