# Security

Please report security issues privately to the-open-engine maintainers. Do not open public issues for secrets, credential exposure, sandbox escapes, or supply-chain vulnerabilities.

Include:

- affected package and version
- operating system and CPU architecture
- reproduction steps
- expected impact
- whether the issue requires local repository access, package install access, or untrusted input

## Supported Versions

The replacement engine receives security fixes in the following release line:

| Version | Supported |
|---|---|
| `0.3.x` | yes |
| legacy releases and earlier snapshots | no |

## Scope

Security-sensitive areas include Git and ASP input capture, bounded parsers, native-provider subprocess execution, installer path and ownership checks, npm archive verification, and release automation.
