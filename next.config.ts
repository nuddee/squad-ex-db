import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./lib/security-headers";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfkit"],
  outputFileTracingIncludes: {
    "/api/batches/[id]/report": [
      "./lib/report/fonts/**/*",
      "./node_modules/pdfkit/js/standard-fonts/**/*",
    ],
    "/api/batches/[id]/report/route": [
      "./lib/report/fonts/**/*",
      "./node_modules/pdfkit/js/standard-fonts/**/*",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: buildSecurityHeaders(process.env),
      },
    ];
  },
};

export default nextConfig;
