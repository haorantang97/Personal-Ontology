# Third-Party Notices

The v2 design review considered public descriptions from several projects. No
code, prompt, schema, template, asset, or dependency from those projects is
included. See `references/external-method-review.md` for the idea-only clean-room
record and observed licenses.

The repository vendors no third-party source or binary dependencies. Its deterministic runtime uses software supplied by the user's environment:

## Python

Python and its standard library are distributed under the Python Software Foundation License and related historical notices. Python is not bundled with this repository.

Official license: <https://docs.python.org/3/license.html>

## SQLite

SQLite is dedicated to the public domain. Python's `sqlite3` module links to the SQLite library available in the runtime environment. SQLite source is not bundled here.

Official copyright statement: <https://sqlite.org/copyright.html>

## SQLCipher (optional external adapter)

SQLCipher is an optional, separately installed external program. This repository does not bundle or copy SQLCipher. If a user selects it, its BSD 3-Clause license and distribution terms apply.

Official repository and license information: <https://www.zetetic.net/sqlcipher/license/>

## Platform and user-selected adapters

WeChat, user-provided keys, export tools, and external decryptors are not bundled. The package does not contain process-memory key extraction or a WeChat circumvention tool. Users must review and comply with each selected tool's license, applicable law, and the platform's terms before use. See `references/legal-and-connector-boundary.md`.
