# Security policy

## Reporting a vulnerability

Please do not open a public GitHub issue. Email
[josh@blueprintr.io](mailto:josh@blueprintr.io) instead with
the subject line `[vellum-editor security]`.

Please include:

- A description of the issue and where it lives in the code.
- Steps to reproduce, ideally with a minimal `.vellum` file or a code
  snippet showing the problematic input.
- Your assessment of impact (what an attacker can do).
- Whether you've shared this with anyone else.

You should expect an acknowledgement within 72 hours and a status
update within 7 days. Coordinated disclosure timing is negotiable;
the default is 90 days from the acknowledgement.

## Scope

Vellum is a client-side React component intended to be embedded in
host applications. The threat model assumes that:

- Diagram files (`.vellum`) may be authored by attackers and opened by
  victims (so file parsing and SVG rendering are trust boundaries).
- Imported icon libraries may contain malicious SVG (so the icon
  ingestion path is a trust boundary).
- The `iconify.design` API is treated as a third-party network
  dependency; responses pass through the SVG sanitizer before render.

In-scope findings include: XSS via `.vellum` files or imported icons,
SVG sanitizer bypasses, prototype pollution via the file format,
zip-slip in the library importer, and any default that pollutes a host
app's global state (window, document listeners, storage keys).

Out of scope: vulnerabilities in your deployment of Vellum (server
config, hosting), denial-of-service via oversized inputs that the host
app can rate-limit, and issues in dependencies that are not reachable
from Vellum's code paths.

## Supported versions

Vellum is pre-1.0. Only the latest commit on `main` receives security
fixes. Once 1.0 ships, the policy will be updated to cover the latest
minor release.
