const editRefusalCategories = [
  "absolute_path",
  "parent_directory",
  "ambiguous_repo_identity",
  "validation_failed",
  "provider_required_missing",
  "schema_mismatch",
  "unsafe_edit",
  "conflict",
  "unsupported_change",
] as const;

export { editRefusalCategories };

type EditRefusalCategory = (typeof editRefusalCategories)[number];

export type { EditRefusalCategory };
