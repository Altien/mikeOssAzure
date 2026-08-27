export const FINTECH_GC_DIGEST_PRESET = {
  id: "fintech-gc-digest",
  name: "Fintech GC Regulatory Digest",
  description:
    "Banking, payments, AI/model-risk, privacy, and cybersecurity developments for a core-processing and digital-payments provider.",
  monitor: {
    name: "Fintech GC Regulatory Digest",
    topic: [
      "Monitor material regulatory, supervisory, enforcement, payment-network, cybersecurity, and industry developments affecting a bank or credit-union core-processing and digital-payments technology provider.",
      "Classify relevance as: Direct - Vendor Obligation; Direct - Examined as Bank Service Provider; Indirect - Client Institution Obligation; Monitor Only; or Not Relevant.",
      "Assess affected business lines, urgency, required action, operative deadline, and possible policy or technical-control gaps. For indirect client obligations, identify client communications and product/API changes. Escalate Critical and High items into a concise GC briefing with source, why it matters, recommended action, timeline, owner, and next steps.",
      "Distinguish proposals from final rules and never invent authority, deadlines, citations, or legal status.",
    ].join("\n\n"),
    jurisdiction: "United States federal and all U.S. states",
    sourceTypes: ["case_law", "statutes"] as const,
    intervalHours: 24,
    lookbackDays: 14,
    maxItemsPerRun: 50,
  },
  sources: [
    [
      "Federal Banking Regulators",
      "OCC - News Releases",
      "https://www.occ.gov/rss/occ_news.xml",
    ],
    [
      "Federal Banking Regulators",
      "OCC - Bulletins",
      "https://www.occ.gov/rss/occ_bulletins.xml",
    ],
    [
      "Federal Banking Regulators",
      "FDIC - Financial Institution Letters",
      "https://public.govdelivery.com/topics/USFDIC_19/feed.rss",
    ],
    [
      "Federal Banking Regulators",
      "FDIC - Press Releases",
      "https://public.govdelivery.com/topics/USFDIC_26/feed.rss",
    ],
    [
      "Federal Banking Regulators",
      "Federal Reserve - Banking and Consumer Regulatory Policy",
      "https://www.federalreserve.gov/feeds/press_bcreg.xml",
    ],
    [
      "Federal Banking Regulators",
      "Federal Reserve - SR and CA Letters",
      "https://www.federalreserve.gov/feeds/bankinginfo-rss.xml",
    ],
    [
      "Federal Banking Regulators",
      "Federal Reserve - All Press Releases",
      "https://www.federalreserve.gov/feeds/press_all.xml",
    ],
    [
      "Federal Banking Regulators",
      "CFPB - Newsroom",
      "https://www.consumerfinance.gov/about-us/newsroom/feed/",
    ],
    [
      "Federal Register",
      "Federal Register - OCC",
      "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=comptroller-of-the-currency",
    ],
    [
      "Federal Register",
      "Federal Register - FDIC",
      "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=federal-deposit-insurance-corporation",
    ],
    [
      "Federal Register",
      "Federal Register - Federal Reserve System",
      "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=federal-reserve-system",
    ],
    [
      "Federal Register",
      "Federal Register - CFPB",
      "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=consumer-financial-protection-bureau",
    ],
    [
      "Federal Register",
      "Federal Register - FinCEN",
      "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=financial-crimes-enforcement-network",
    ],
    [
      "Federal Register",
      "Federal Register - Treasury",
      "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=treasury-department",
    ],
    [
      "Federal Register",
      "Federal Register - NCUA",
      "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=national-credit-union-administration",
    ],
    [
      "Federal Register",
      "Federal Register - Bank Service Company",
      "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bterm%5D=bank+service+company",
    ],
    [
      "Federal Register",
      "Federal Register - Open Banking",
      "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bterm%5D=open+banking",
    ],
    [
      "State Regulators",
      "NY DFS - Press Releases",
      "https://www.dfs.ny.gov/reports_and_publications/press_releases/rss.xml",
    ],
    ["State Regulators", "California DFPI - News", "https://dfpi.ca.gov/feed/"],
    [
      "State Regulators",
      "California DFPI - Press Releases",
      "https://dfpi.ca.gov/news/press-releases/feed/",
    ],
    [
      "State Regulators",
      "Texas Department of Banking",
      "https://www.dob.texas.gov/rss.xml",
    ],
    ["Trade Press", "American Banker", "https://www.americanbanker.com/rss"],
    [
      "Trade Press",
      "Payments Dive",
      "https://www.paymentsdive.com/feeds/news/",
    ],
    [
      "Trade Press",
      "Finextra Headlines",
      "https://www.finextra.com/rss/headlines.aspx",
    ],
    [
      "Trade Press",
      "Digital Transactions",
      "https://www.digitaltransactions.net/feed/",
    ],
    ["Trade Press", "PYMNTS", "https://www.pymnts.com/feed/"],
    [
      "AI and Emerging Tech",
      "Consumer Finance Monitor - AI",
      "https://www.consumerfinancemonitor.com/artificial-intelligence/feed/",
    ],
    [
      "AI and Emerging Tech",
      "Consumer Finance Monitor",
      "https://www.consumerfinancemonitor.com/feed/",
    ],
    [
      "AI and Emerging Tech",
      "Consumer Financial Services Law Monitor",
      "https://www.consumerfinancialserviceslawmonitor.com/feed/",
    ],
    [
      "Cybersecurity",
      "CISA - Cybersecurity Advisories",
      "https://www.cisa.gov/cybersecurity-advisories/all.xml",
    ],
    ["Cybersecurity", "CISA - News", "https://www.cisa.gov/news.xml"],
    [
      "Cybersecurity",
      "CISA - Alerts",
      "https://www.cisa.gov/uscert/ncas/alerts.xml",
    ],
    [
      "Cybersecurity",
      "CIS and MS-ISAC - Advisories",
      "https://www.cisecurity.org/feed/advisories",
    ],
  ].map(([category, name, url]) => ({
    kind: "rss" as const,
    category,
    name,
    url,
    enabled: true,
  })),
};
