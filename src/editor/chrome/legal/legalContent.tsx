/* Tab content for the Legal dialog.
 *
 * The IP-complaints and Terms tabs are deployment-specific — anyone running
 * a public instance of Vellum needs their own legal copy. The defaults below
 * are neutral placeholders that point operators at the file. The Credits tab
 * is reusable: it documents the icon attribution model so users understand
 * what does (and doesn't) ship in the box.
 *
 * To customize for a deployment, replace the bodies of `IpComplaintsContent`
 * and `TermsContent` with your own copy. The dialog (LegalDialog.tsx) is
 * already wired to show all three tabs. */

import type { ReactNode } from 'react';

function H1({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-[15px] font-semibold text-fg mb-1 leading-tight">
      {children}
    </h1>
  );
}

function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase mt-5 mb-2">
      {children}
    </h2>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-fg leading-relaxed">{children}</p>;
}

function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-fg-muted text-[11px] italic leading-relaxed">
      {children}
    </p>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[11px] bg-bg-emphasis px-1 py-[1px] rounded">
      {children}
    </code>
  );
}

/* IP COMPLAINTS */

export function IpComplaintsContent() {
  return (
    <div>
      <H1>Intellectual property complaints</H1>

      <Lead>
        This page is deployment-specific. The OSS distribution of Vellum
        ships a placeholder; whoever is hosting the instance you are using
        is responsible for the takedown procedure that applies here.
      </Lead>

      <H2>Operators</H2>
      <P>
        If you are running an instance of Vellum and shipping it to users,
        replace the body of <Code>IpComplaintsContent</Code> in{' '}
        <Code>src/editor/chrome/legal/legalContent.tsx</Code> with your own
        takedown policy: contact addresses (DMCA agent for U.S. operators),
        what information you require in a notice, and the response time you
        commit to.
      </P>

      <H2>Users</H2>
      <P>
        If you are using a deployed instance and need to contact the
        operator about a complaint, refer to that deployment's legal page
        rather than this fallback text.
      </P>
    </div>
  );
}

/* CREDITS */

export function CreditsContent() {
  return (
    <div>
      <H1>Library credits &amp; attributions</H1>

      <Lead>
        Vellum's default install ships with no bundled vendor icon packs.
        Vendor and community icons enter via the <Code>+ Load</Code> import
        flow; on-demand search through{' '}
        <a
          className="text-accent"
          href="https://iconify.design"
          target="_blank"
          rel="noreferrer noopener"
        >
          iconify.design
        </a>{' '}
        is also available. Each icon's per-set license is shown on its tile.
      </Lead>

      <H2>How attribution works</H2>
      <P>
        When a diagram contains icons whose licenses require attribution
        (e.g., CC BY 4.0), the document attributions panel — bottom-left of
        the editor — lists the relevant icon sets, authors, and licenses.
        That panel is also reusable as an export footer.
      </P>

      <H2>Trademark</H2>
      <P>
        Product names, logos, and brands depicted in any imported icon
        library are the property of their respective owners. Vellum's own
        use of such names is for identification only and does not imply
        endorsement. Users importing branded packs are responsible for
        complying with each vendor's published brand guidelines.
      </P>

      <H2>Vellum's own license</H2>
      <P>
        Vellum is released under the PolyForm Noncommercial License
        1.0.0 — free for noncommercial use, commercial use requires a
        separate license. See <Code>LICENSE</Code> in the repository.
      </P>

      <H2>Open-source libraries</H2>
      <P>
        Vellum is built on React, Zustand, Radix UI primitives, Tailwind
        CSS, the <Code>yaml</Code> parser, <Code>zod</Code>, and DOMPurify,
        each under its own permissive license. Full dependency licenses
        are recorded in <Code>package.json</Code> and the corresponding{' '}
        <Code>node_modules/&lt;pkg&gt;/LICENSE</Code> files.
      </P>
    </div>
  );
}

/* TERMS */

export function TermsContent() {
  return (
    <div>
      <H1>Terms of service</H1>

      <Lead>
        This page is deployment-specific. The OSS distribution of Vellum
        ships a placeholder; the terms that govern your use of any specific
        instance are set by whoever is hosting it.
      </Lead>

      <H2>Operators</H2>
      <P>
        Replace the body of <Code>TermsContent</Code> in{' '}
        <Code>src/editor/chrome/legal/legalContent.tsx</Code> with your
        deployment's terms of service. At minimum, cover: who owns
        user-created content, how third-party icon libraries imported by
        users are handled, takedown procedure, acceptable use, service
        availability, and termination.
      </P>

      <H2>Local / desktop use</H2>
      <P>
        If you are running Vellum locally for personal use, no terms-of-
        service apply — Vellum itself is released under the PolyForm
        Noncommercial License 1.0.0 (see <Code>LICENSE</Code> in the
        repository), which permits any noncommercial use including
        personal and hobby projects.
      </P>
    </div>
  );
}
