// Vendor keyword catalog for icon-search vendor detection.
//
// When a user's icon-search query token-matches one of a vendor's `keywords`,
// the search UI surfaces a vendor card that resolves to either:
//   - the already-imported stencil library for that vendor (if present), or
//   - the official stencil pack landing page so the user can download +
//     upload it themselves (phase 2 wiring).
//
// Match contract:
//   - all keywords are lowercase
//   - match is whole-token (split query on whitespace / punctuation, then
//     compare each token against the keyword set), case-insensitive
//   - per vendor: 3–10 keywords covering canonical short name, expanded
//     official name, common nicknames, and any acronym people actually type
//
// This list is intentionally over-inclusive on vendors people diagram with —
// false hits are cheap (a card the user ignores), missing a vendor is the
// expensive failure mode (user assumes Vellum doesn't know about it).
//
// `stencilUrl` is the official icon/stencil pack landing page. Consumed by
// the phase-2 vendor card; left as the canonical anchor today so we don't
// have to re-research these later. Some vendors host stencils behind a
// gated download or partner portal — those are marked with a TODO so
// phase 2 can decide whether to deep-link or surface a "search for it"
// fallback.

export type VendorStencilEntry = {
  /** Stable id; also the key under which an imported library is registered. */
  id: string;
  /** Display name shown on the vendor card. */
  name: string;
  /** Lowercase tokens matched against the user's icon-search query. */
  keywords: string[];
  /** Official stencil/icon pack landing page (phase-2 consumer). */
  stencilUrl?: string;
};

export const VENDOR_STENCILS: VendorStencilEntry[] = [
  // -------------------------------------------------------------------------
  // Hyperscalers / public cloud
  // -------------------------------------------------------------------------
  {
    id: 'aws',
    name: 'Amazon Web Services',
    keywords: ['aws', 'amazon', 'amazon web services', 'a.w.s'],
    stencilUrl: 'https://aws.amazon.com/architecture/icons/',
  },
  {
    id: 'azure',
    name: 'Microsoft Azure',
    keywords: ['azure', 'microsoft azure', 'msft azure', 'ms azure'],
    stencilUrl: 'https://learn.microsoft.com/en-us/azure/architecture/icons/',
  },
  {
    id: 'gcp',
    name: 'Google Cloud',
    keywords: ['gcp', 'google cloud', 'google cloud platform', 'gcloud'],
    stencilUrl: 'https://cloud.google.com/icons',
  },
  {
    id: 'oci',
    name: 'Oracle Cloud Infrastructure',
    keywords: ['oci', 'oracle cloud', 'oracle cloud infrastructure', 'oracle'],
    stencilUrl: 'https://www.oracle.com/cloud/oci-symbols/',
  },
  {
    id: 'ibm-cloud',
    name: 'IBM Cloud',
    keywords: ['ibm', 'ibm cloud', 'bluemix', 'ibmcloud'],
    stencilUrl: 'https://www.ibm.com/design/language/iconography/cloud-icons/',
  },
  {
    id: 'alibaba-cloud',
    name: 'Alibaba Cloud',
    keywords: ['alibaba', 'alibaba cloud', 'aliyun', 'alicloud'],
    stencilUrl: 'https://www.alibabacloud.com/architecture/icon',
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    keywords: ['digitalocean', 'digital ocean', 'do'],
    stencilUrl: 'https://www.digitalocean.com/brand',
  },

  // -------------------------------------------------------------------------
  // Networking & security
  // -------------------------------------------------------------------------
  {
    id: 'cisco',
    name: 'Cisco',
    keywords: ['cisco', 'cisco systems', 'meraki', 'webex', 'duo'],
    stencilUrl:
      'https://www.cisco.com/c/en/us/about/brand-center/network-topology-icons.html',
  },
  {
    id: 'fortinet',
    name: 'Fortinet',
    keywords: [
      'fortinet',
      'forti',
      'fortigate',
      'fortianalyzer',
      'fortimanager',
      'fortiweb',
      'fortisiem',
      'fortisoar',
    ],
    stencilUrl: 'https://www.fortinet.com/resources/icon-library',
  },
  {
    id: 'palo-alto',
    name: 'Palo Alto Networks',
    keywords: [
      'palo alto',
      'palo alto networks',
      'paloalto',
      'pan',
      'panw',
      'prisma',
      'cortex xdr',
    ],
    // TODO(phase-2): PAN ships stencils via partner portal — confirm public anchor
    stencilUrl: 'https://www.paloaltonetworks.com/resources/diagram-icons',
  },
  {
    id: 'juniper',
    name: 'Juniper Networks',
    keywords: ['juniper', 'juniper networks', 'junos', 'mist'],
    stencilUrl:
      'https://www.juniper.net/us/en/design-and-architecture-icons.html',
  },
  {
    id: 'f5',
    name: 'F5',
    keywords: ['f5', 'f5 networks', 'big-ip', 'bigip', 'nginx'],
    stencilUrl: 'https://www.f5.com/company/policies/trademarks',
  },
  {
    id: 'checkpoint',
    name: 'Check Point',
    keywords: ['check point', 'checkpoint', 'cp', 'checkpoint software'],
    // TODO(phase-2): stencils live behind UserCenter login
    stencilUrl: 'https://www.checkpoint.com/downloads/',
  },
  {
    id: 'arista',
    name: 'Arista Networks',
    keywords: ['arista', 'arista networks', 'eos'],
    stencilUrl: 'https://www.arista.com/en/support/product-documentation',
  },
  {
    id: 'aruba',
    name: 'HPE Aruba Networking',
    keywords: ['aruba', 'aruba networks', 'hpe aruba', 'aruba central'],
    stencilUrl:
      'https://www.arubanetworks.com/support-services/visio-stencils/',
  },
  {
    id: 'sonicwall',
    name: 'SonicWall',
    keywords: ['sonicwall', 'sonic wall', 'sonicos'],
    stencilUrl: 'https://www.sonicwall.com/support/',
  },
  {
    id: 'crowdstrike',
    name: 'CrowdStrike',
    keywords: ['crowdstrike', 'crowd strike', 'falcon'],
    stencilUrl: 'https://www.crowdstrike.com/brand/',
  },
  {
    id: 'okta',
    name: 'Okta',
    keywords: ['okta', 'okta identity', 'auth0'],
    stencilUrl: 'https://www.okta.com/press-room/media-assets/',
  },

  // -------------------------------------------------------------------------
  // Virtualization & infrastructure
  // -------------------------------------------------------------------------
  {
    id: 'vmware',
    name: 'VMware',
    keywords: ['vmware', 'vsphere', 'vcenter', 'esxi', 'nsx', 'vsan'],
    stencilUrl:
      'https://core.vmware.com/resource/vmware-cloud-foundation-icons-stencils',
  },
  {
    id: 'citrix',
    name: 'Citrix',
    keywords: ['citrix', 'xenapp', 'xendesktop', 'netscaler'],
    stencilUrl: 'https://www.citrix.com/community/citrix-developer/',
  },
  {
    id: 'nutanix',
    name: 'Nutanix',
    keywords: ['nutanix', 'ahv', 'prism'],
    stencilUrl: 'https://www.nutanix.com/products',
  },
  {
    id: 'redhat',
    name: 'Red Hat',
    keywords: ['red hat', 'redhat', 'rhel', 'openshift', 'ansible'],
    stencilUrl: 'https://www.redhat.com/en/about/brand/standards/logo',
  },
  {
    id: 'hashicorp',
    name: 'HashiCorp',
    keywords: [
      'hashicorp',
      'terraform',
      'vault',
      'consul',
      'nomad',
      'packer',
      'vagrant',
    ],
    stencilUrl: 'https://www.hashicorp.com/brand',
  },

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------
  {
    id: 'netapp',
    name: 'NetApp',
    keywords: ['netapp', 'net app', 'ontap'],
    stencilUrl: 'https://www.netapp.com/us/media/netapp-visio-stencils.zip',
  },
  {
    id: 'pure-storage',
    name: 'Pure Storage',
    keywords: ['pure', 'pure storage', 'flasharray', 'flashblade'],
    stencilUrl: 'https://www.purestorage.com/company/branding-guidelines.html',
  },
  {
    id: 'dell-emc',
    name: 'Dell Technologies',
    keywords: ['dell', 'dell emc', 'emc', 'dell technologies', 'powerstore'],
    stencilUrl:
      'https://www.dell.com/community/Visio-Stencils/ct-p/Visio_Stencils',
  },
  {
    id: 'hpe',
    name: 'Hewlett Packard Enterprise',
    keywords: ['hpe', 'hewlett packard enterprise', 'hp enterprise', 'proliant'],
    stencilUrl: 'https://www.hpe.com/us/en/about/legal/trademarks-list.html',
  },

  // -------------------------------------------------------------------------
  // Container / cloud-native ecosystem
  // -------------------------------------------------------------------------
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    keywords: ['kubernetes', 'k8s', 'kube'],
    stencilUrl:
      'https://github.com/kubernetes/community/tree/master/icons',
  },
  {
    id: 'docker',
    name: 'Docker',
    keywords: ['docker', 'dockerhub', 'docker hub'],
    stencilUrl: 'https://www.docker.com/company/newsroom/media-resources/',
  },
  {
    id: 'cncf',
    name: 'CNCF',
    keywords: [
      'cncf',
      'cloud native',
      'cloud native computing foundation',
      'istio',
      'envoy',
      'helm',
    ],
    stencilUrl: 'https://github.com/cncf/artwork',
  },

  // -------------------------------------------------------------------------
  // Data / databases
  // -------------------------------------------------------------------------
  {
    id: 'mongodb',
    name: 'MongoDB',
    keywords: ['mongodb', 'mongo', 'mongo db', 'atlas'],
    stencilUrl: 'https://www.mongodb.com/brand-resources',
  },
  {
    id: 'snowflake',
    name: 'Snowflake',
    keywords: ['snowflake', 'snowflake data', 'snowpark'],
    stencilUrl: 'https://www.snowflake.com/legal/logo-and-trademark-guidelines/',
  },
  {
    id: 'databricks',
    name: 'Databricks',
    keywords: ['databricks', 'data bricks', 'lakehouse'],
    stencilUrl: 'https://www.databricks.com/brand',
  },
  {
    id: 'elastic',
    name: 'Elastic',
    keywords: ['elastic', 'elasticsearch', 'kibana', 'logstash', 'elk'],
    stencilUrl: 'https://www.elastic.co/brand',
  },
  {
    id: 'redis',
    name: 'Redis',
    keywords: ['redis', 'redis labs', 'redis enterprise'],
    stencilUrl: 'https://redis.io/legal/trademark-policy/',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    keywords: ['postgres', 'postgresql', 'pg'],
    stencilUrl: 'https://www.postgresql.org/about/policies/trademarks/',
  },

  // -------------------------------------------------------------------------
  // Observability / DevOps SaaS
  // -------------------------------------------------------------------------
  {
    id: 'datadog',
    name: 'Datadog',
    keywords: ['datadog', 'data dog', 'dd'],
    stencilUrl: 'https://www.datadoghq.com/about/resources/',
  },
  {
    id: 'splunk',
    name: 'Splunk',
    keywords: ['splunk', 'splunk enterprise', 'splunk cloud'],
    stencilUrl: 'https://www.splunk.com/en_us/about-splunk/brand.html',
  },
  {
    id: 'grafana',
    name: 'Grafana Labs',
    keywords: ['grafana', 'grafana labs', 'loki', 'tempo', 'mimir'],
    stencilUrl: 'https://grafana.com/about/brand/',
  },
  {
    id: 'newrelic',
    name: 'New Relic',
    keywords: ['new relic', 'newrelic', 'nr'],
    stencilUrl: 'https://newrelic.com/about/media-kit',
  },
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    keywords: ['pagerduty', 'pager duty', 'pd'],
    stencilUrl: 'https://www.pagerduty.com/brand/',
  },

  // -------------------------------------------------------------------------
  // Source control / collaboration
  // -------------------------------------------------------------------------
  {
    id: 'github',
    name: 'GitHub',
    keywords: ['github', 'gh', 'git hub', 'github actions'],
    stencilUrl: 'https://github.com/logos',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    keywords: ['gitlab', 'git lab'],
    stencilUrl: 'https://about.gitlab.com/press/press-kit/',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    keywords: [
      'atlassian',
      'jira',
      'confluence',
      'bitbucket',
      'trello',
      'opsgenie',
    ],
    stencilUrl: 'https://atlassian.design/resources/logo-library',
  },
  {
    id: 'slack',
    name: 'Slack',
    keywords: ['slack', 'slack technologies'],
    stencilUrl: 'https://slack.com/media-kit',
  },

  // -------------------------------------------------------------------------
  // Edge / CDN
  // -------------------------------------------------------------------------
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    keywords: ['cloudflare', 'cf', 'cloud flare', 'workers'],
    stencilUrl: 'https://www.cloudflare.com/logo/',
  },
  {
    id: 'fastly',
    name: 'Fastly',
    keywords: ['fastly', 'fastly cdn'],
    stencilUrl: 'https://www.fastly.com/about/press/media-kit',
  },
  {
    id: 'akamai',
    name: 'Akamai',
    keywords: ['akamai', 'akamai technologies', 'linode'],
    stencilUrl: 'https://www.akamai.com/legal/trademark',
  },

  // -------------------------------------------------------------------------
  // SaaS marks commonly diagrammed
  // -------------------------------------------------------------------------
  {
    id: 'salesforce',
    name: 'Salesforce',
    keywords: ['salesforce', 'sfdc', 'sales force', 'force.com'],
    stencilUrl: 'https://www.salesforce.com/company/legal/intellectual/',
  },
  {
    id: 'servicenow',
    name: 'ServiceNow',
    keywords: ['servicenow', 'service now', 'snow'],
    stencilUrl: 'https://www.servicenow.com/company/media/press-kit.html',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    keywords: ['stripe', 'stripe payments'],
    stencilUrl: 'https://stripe.com/newsroom/brand-assets',
  },
  {
    id: 'twilio',
    name: 'Twilio',
    keywords: ['twilio', 'segment', 'sendgrid'],
    stencilUrl: 'https://www.twilio.com/en-us/legal/brand-guidelines',
  },
  {
    id: 'auth0',
    name: 'Auth0',
    keywords: ['auth0', 'auth zero'],
    stencilUrl: 'https://auth0.com/press',
  },

  // -------------------------------------------------------------------------
  // Hosting / PaaS
  // -------------------------------------------------------------------------
  {
    id: 'vercel',
    name: 'Vercel',
    keywords: ['vercel', 'next.js', 'nextjs'],
    stencilUrl: 'https://vercel.com/design/brands',
  },
  {
    id: 'netlify',
    name: 'Netlify',
    keywords: ['netlify'],
    stencilUrl: 'https://www.netlify.com/press/',
  },
  {
    id: 'heroku',
    name: 'Heroku',
    keywords: ['heroku'],
    stencilUrl: 'https://brand.heroku.com/',
  },
];

/**
 * Build a flat lookup map from any keyword (lowercased) → vendor entry.
 * Computed once at module load; callers should treat the map as read-only.
 */
export const VENDOR_KEYWORD_INDEX: ReadonlyMap<string, VendorStencilEntry> =
  (() => {
    const m = new Map<string, VendorStencilEntry>();
    for (const v of VENDOR_STENCILS) {
      for (const kw of v.keywords) {
        const key = kw.toLowerCase().trim();
        if (!key) continue;
        // First entry wins on collision — log so we notice if two vendors
        // ever claim the same keyword (would be a curation bug).
        if (m.has(key) && m.get(key)?.id !== v.id) {
          // eslint-disable-next-line no-console
          console.warn(
            `[vendor-stencils] keyword collision: "${key}" claimed by ` +
              `${m.get(key)?.id} and ${v.id} — keeping ${m.get(key)?.id}`,
          );
          continue;
        }
        m.set(key, v);
      }
    }
    return m;
  })();

/**
 * Match a free-form icon-search query against the vendor catalog.
 *
 * Tokenizes on whitespace, slash, dot, dash, and underscore, then checks
 * each token AND adjacent token-pairs (so "amazon web services" hits the
 * "amazon web services" keyword as a 3-gram even though our index is
 * keyed on full strings — we generate up to 3-grams from the query).
 *
 * Returns the matched vendors in the order their first matching token
 * appeared in the query, deduplicated by vendor id.
 */
export function matchVendors(query: string): VendorStencilEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const tokens = q.split(/[\s_/\-:.]+/).filter(Boolean);
  const ngrams: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    ngrams.push(tokens[i]);
    if (i + 1 < tokens.length) ngrams.push(`${tokens[i]} ${tokens[i + 1]}`);
    if (i + 2 < tokens.length)
      ngrams.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }

  const seen = new Set<string>();
  const hits: VendorStencilEntry[] = [];
  for (const g of ngrams) {
    const v = VENDOR_KEYWORD_INDEX.get(g);
    if (v && !seen.has(v.id)) {
      seen.add(v.id);
      hits.push(v);
    }
  }
  return hits;
}
