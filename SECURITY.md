# Security policy

## Reporting a vulnerability

Please report it privately, through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability** ([direct link](https://github.com/buzludeniz/skeinwise/security/advisories/new)). Please don't open a
public issue, pull request or discussion for it.

You will get a reply within 72 hours. It will say whether the report is confirmed, and what happens next. When a fix
ships, the advisory is published with credit to you, unless you'd rather stay unnamed.

A useful report says:

- the version (`skeinwise --version`), your OS and your Node version;
- the steps to reproduce it, on the invented demo record (`skeinwise demo`) or other made-up data;
- what an attacker gains.

Please never send real chats, notes or keys, yours or anyone else's.

## Supported versions

| Version | Fixes |
|---|---|
| 1.0.x, the latest release | Yes |
| Before 1.0 | No: please update |

## Scope

[docs/security.md](docs/security.md) covers what Skeinwise defends against, what leaves your computer, and the known
limits of the Lock, agent access and redaction. A limit described there is not a vulnerability, though a better way
around it is always welcome as an issue.
