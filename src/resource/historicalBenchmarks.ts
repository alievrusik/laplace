type HistoricalBenchmark = {
  id: string;
  year: number;
  title: string;
  sourceName: string;
  sourceUrl: string;
  category: "team_rates" | "cloud" | "delivery" | "security";
  normalizedSample: Record<string, string | number>;
};

export const HISTORICAL_BENCHMARKS: HistoricalBenchmark[] = [
  {
    id: "market-rates-2024-fullstack",
    year: 2024,
    title: "Global contractor rates snapshot for full-stack/backend roles",
    sourceName: "Upwork Public Rate Pages",
    sourceUrl: "https://www.upwork.com/hire/",
    category: "team_rates",
    normalizedSample: {
      seniorBackendUsdPerHourMin: 55,
      seniorBackendUsdPerHourMax: 120,
      fullstackUsdPerHourMin: 45,
      fullstackUsdPerHourMax: 95,
    },
  },
  {
    id: "market-rates-2025-devops",
    year: 2025,
    title: "DevOps and platform engineering contract market range",
    sourceName: "Toptal Public Talent Pages",
    sourceUrl: "https://www.toptal.com/",
    category: "team_rates",
    normalizedSample: {
      devopsUsdPerHourMin: 60,
      devopsUsdPerHourMax: 140,
      sreUsdPerHourMin: 70,
      sreUsdPerHourMax: 150,
    },
  },
  {
    id: "cloud-pricing-2025-baseline",
    year: 2025,
    title: "Cloud baseline cost envelopes for app + DB + observability",
    sourceName: "AWS Public Pricing",
    sourceUrl: "https://aws.amazon.com/pricing/",
    category: "cloud",
    normalizedSample: {
      smallProdMonthlyUsdMin: 400,
      smallProdMonthlyUsdMax: 1500,
      mediumProdMonthlyUsdMin: 1800,
      mediumProdMonthlyUsdMax: 6000,
    },
  },
  {
    id: "delivery-bench-2023",
    year: 2023,
    title: "Engineering delivery benchmark for lead-time and deployment frequency",
    sourceName: "Google Cloud DORA / Accelerate reports",
    sourceUrl: "https://cloud.google.com/devops/state-of-devops",
    category: "delivery",
    normalizedSample: {
      productionHardeningWeeksMin: 4,
      productionHardeningWeeksMax: 10,
      releaseStabilizationWeeksMin: 2,
      releaseStabilizationWeeksMax: 6,
    },
  },
  {
    id: "owasp-nist-security-2024",
    year: 2024,
    title: "Typical security hardening overhead for internet-facing applications",
    sourceName: "OWASP + NIST practices (public guidance)",
    sourceUrl: "https://owasp.org/",
    category: "security",
    normalizedSample: {
      securityOverheadPercentMin: 10,
      securityOverheadPercentMax: 25,
      minimalSecurityReviewWeeksMin: 2,
      minimalSecurityReviewWeeksMax: 5,
    },
  },
];

export function buildHistoricalContext(): {
  sources: string[];
  summary: string;
} {
  const sources = HISTORICAL_BENCHMARKS.map((item) => `${item.sourceName} (${item.year}): ${item.sourceUrl}`);
  const summary = HISTORICAL_BENCHMARKS.map((item) => {
    return `${item.id}: ${JSON.stringify(item.normalizedSample)}`;
  }).join("\n");
  return { sources, summary };
}

export function estimateRangeFromHistoricalData(args: {
  contextText: string;
}): {
  timelineWeeks: { min: number; max: number };
  budgetUsd: { min: number; max: number };
  infraMonthlyUsd: { min: number; max: number };
  confidencePenalty: number;
} {
  const text = args.contextText.toLowerCase();
  const isVision = /vision|image|photo|segmentation|detect|sam3|изображ|фото|сегментац|детекц/.test(text);
  const hasEnterpriseSignals = /enterprise|sso|sla|high load|hipaa|pii|multi-tenant|compliance|24\/7|audit/.test(text);
  const hasRealtimeSignals = /realtime|real-time|streaming|websocket|low latency|онлайн/.test(text);

  let timelineMin = 8;
  let timelineMax = 16;
  let budgetMin = 50000;
  let budgetMax = 140000;
  let infraMin = 400;
  let infraMax = 1800;
  let confidencePenalty = 0.15;

  if (isVision) {
    timelineMin += 2;
    timelineMax += 4;
    budgetMin += 10000;
    budgetMax += 30000;
    infraMin += 300;
    infraMax += 1200;
    confidencePenalty += 0.05;
  }

  if (hasRealtimeSignals) {
    timelineMin += 2;
    timelineMax += 4;
    budgetMin += 8000;
    budgetMax += 24000;
    infraMin += 400;
    infraMax += 1500;
    confidencePenalty += 0.05;
  }

  if (hasEnterpriseSignals) {
    timelineMin += 4;
    timelineMax += 8;
    budgetMin += 25000;
    budgetMax += 70000;
    infraMin += 1200;
    infraMax += 5000;
    confidencePenalty += 0.1;
  }

  return {
    timelineWeeks: { min: timelineMin, max: timelineMax },
    budgetUsd: { min: budgetMin, max: budgetMax },
    infraMonthlyUsd: { min: infraMin, max: infraMax },
    confidencePenalty: Math.min(0.45, confidencePenalty),
  };
}
