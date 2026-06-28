export const CLONE_DUPLICATION_CHECK_ID = "clone.duplication";

export const cloneValidationCheckIds = [CLONE_DUPLICATION_CHECK_ID] as const;

export type CloneValidationCheckId = (typeof cloneValidationCheckIds)[number];
