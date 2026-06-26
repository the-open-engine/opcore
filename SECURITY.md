# Security

Please report security issues privately to the-open-engine maintainers. Do not open public issues for secrets, credential exposure, sandbox escapes, or supply-chain vulnerabilities.

Include:

- affected package and version
- operating system and CPU architecture
- reproduction steps
- expected impact
- whether the issue requires local repository access, package install access, or untrusted input

## Supported Versions

After the first public release, the supported security line is:

| Version | Supported |
|---|---|
| `0.1.x-alpha` | yes |
| earlier snapshots | no |

## Scope

Security-sensitive areas include the native graph artifact resolver, graph sidecar process execution, edit plan path policy, atomic writes, validation overlays, package contents, and release automation.
