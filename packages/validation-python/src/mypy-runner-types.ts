import type { TypeCapabilityArgs, TypeCapabilityResult, TypeExecutionContext } from "./type-runner-types.js";

export type MypyCapabilityResult = TypeCapabilityResult;
export type MypyCapabilityArgs = Omit<TypeCapabilityArgs, "authority">;
export type MypyExecutionContext = Omit<TypeExecutionContext, "args"> & { args: MypyCapabilityArgs };
