# @the-open-engine/opcore-validation-clone

Internal Opcore validation adapter for duplicate-code clone findings.

The adapter owns the `clone.duplication` validation check. It depends only on
shared contracts and the validation runner, and receives graph-core execution
through an injected native invoker from the composing runtime package.
