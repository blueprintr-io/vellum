# Library credits & attributions

Vellum's default install ships with no bundled vendor icon packs. Vendor
and community icons enter via the `+ Load` import flow, and on-demand
search through [iconify.design](https://iconify.design) is also available.
Each icon's per-set license is shown on its tile.

## How attribution works

When a diagram contains icons whose licenses require attribution (e.g.,
CC BY 4.0), the document attributions panel — bottom-left of the editor —
lists the relevant icon sets, authors, and licenses. That panel is
reusable as a footer band in PDF/PNG exports.

## Iconify (community sets, fetched at search time)

Vellum integrates [Iconify](https://iconify.design)'s public search API
to surface community icon sets on demand. The Iconify catalog is not
bundled at rest; results are fetched on demand and the per-icon license
is shown on every tile. Required attribution per the icon's license is
the responsibility of the user when they include an Iconify icon in their
diagram.

## User-imported libraries

Libraries imported via the `+ Load` flow are not hosted by Vellum and
are not listed here. Users are responsible for ensuring they have the
rights to use any content they import.

## Trademark

Product names, logos, and brands depicted in any imported icon library
are the property of their respective owners. Vellum's own use of such
names is for identification only and does not imply endorsement.

## Open-source dependencies

Vellum itself is released under PolyForm Noncommercial 1.0.0 (see the
top-level `LICENSE`). It is built on a number of open-source libraries
including React, Zustand, Radix UI primitives, Tailwind CSS, the `yaml`
parser, `zod`, and DOMPurify, each under its own permissive license.
Full dependency licenses are recorded in `package.json` and the
corresponding `node_modules/<pkg>/LICENSE` files.
