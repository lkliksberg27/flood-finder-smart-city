import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: "/analytics",
        destination: "/flood-events",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;

